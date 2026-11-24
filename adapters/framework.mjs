import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import GithubSlugger, { slug } from 'github-slugger';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import YAML from 'yaml';

import { robotsContent } from '../scripts/publication.mjs';
import { isPublishableSupportPath } from '../scripts/support-paths.mjs';
import { apiReferenceMarkup, apiReferenceSidebar, prepareApiReferences } from '../scripts/api-references.mjs';
import {
  PROFILE_SECTION,
  checkOptions,
  checkProfileFunctionalityLinks,
  collectConditions,
  flattenRequirements,
  observabilityWarning,
  parseToc,
  profileForSource,
  resolveProfiles,
  verificationOf,
  yamlPage,
} from './framework-model.mjs';

const execFileAsync = promisify(execFile);
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);
const HTML_REFERENCE = /(?<attribute>href|src)=(?<quote>["'])(?<url>.*?)(?:\k<quote>)/g;
const DOCUMENTATION_LABEL = /^(Purpose|Prerequisite|Condition|Scope|Constraint|Evidence|Verification):\s*(.*)$/;

function textContent(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return (node.children ?? []).map(textContent).join('');
}

function offset(position, sourceName) {
  if (position?.offset === undefined) {
    throw new Error(`${sourceName}: parser did not provide source offsets`);
  }
  return position.offset;
}

export function routeFor(source) {
  if (source === 'README.md') return '';
  const route = source.endsWith('/README.md')
    ? source.slice(0, -'/README.md'.length)
    : source.replace(/\.(?:md|ya?ml)$/i, '');
  return route
    .split('/')
    .map((segment) => slug(segment))
    .join('/');
}

function normalizeBase(base) {
  if (typeof base !== 'string' || !base.startsWith('/')) {
    throw new Error(`base must be an absolute URL path, received ${JSON.stringify(base)}`);
  }
  return `${base.replace(/\/+$/, '')}/`.replace(/^$/, '/');
}

function baseUrl(base, relative = '') {
  const normalized = normalizeBase(base);
  return relative ? `${normalized}${relative}` : normalized;
}

function safeRelativeTarget(sourceName, target, directory = path.posix.dirname(sourceName)) {
  const pathname = target.split(/[?#]/, 1)[0];
  const normalized = path.posix.normalize(path.posix.join(directory, pathname));
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${sourceName}: relative reference escapes the source root: ${target}`);
  }
  return normalized;
}

function isExternalReference(reference) {
  return /^[A-Za-z][A-Za-z+.-]*:/.test(reference) || reference.startsWith('//');
}

// A local reference resolves against its page, or, with a leading "/", against the
// specification root. The build's base is that root, so a specification published
// under a project subpath only ever refers to its own pages and assets.
function localTarget(sourceName, pathname) {
  if (!pathname.startsWith('/')) return safeRelativeTarget(sourceName, pathname);
  const relative = pathname.replace(/^\/+/, '');
  return relative ? safeRelativeTarget(sourceName, relative, '.') : '.';
}

function sourceFrontmatter(tree) {
  const node = tree.children.find((child) => child.type === 'yaml');
  if (!node) return { node: undefined, value: {} };
  return { node, value: YAML.parse(node.value) ?? {} };
}

function anchorAttributes(value) {
  const match = /^<a\s+([^>]+?)(?:><\/a>|>)$/i.exec(value?.trim() ?? '');
  if (!match) return undefined;
  return Object.fromEntries(
    [...match[1].matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)].map((item) => [
      item[1].toLowerCase(),
      item[3],
    ]),
  );
}

function explicitHeadingAnchor(children, index) {
  const child = children[index];
  if (child?.type !== 'html') return undefined;
  const attributes = anchorAttributes(child.value);
  if (!attributes?.id || attributes.href !== `#${attributes.id}`) return undefined;
  const compound = /<\/a>$/i.test(child.value.trim());
  if (compound) return { id: attributes.id, count: 1 };
  if (children[index + 1]?.type === 'html' && children[index + 1].value.trim().toLowerCase() === '</a>') {
    return { id: attributes.id, count: 2 };
  }
  return undefined;
}

function redundantStandaloneAnchorReplacements(tree, sourceName) {
  const replacements = [];
  function inspect(parent) {
    const children = parent.children ?? [];
    for (let index = 0; index < children.length - 1; index += 1) {
      const paragraph = children[index];
      const heading = children[index + 1];
      if (paragraph.type !== 'paragraph' || heading.type !== 'heading') continue;
      const first = paragraph.children?.[0];
      const attributes = first?.type === 'html' ? anchorAttributes(first.value) : undefined;
      if (!attributes?.id || ![undefined, `#${attributes.id}`].includes(attributes.href)) continue;
      const closing = paragraph.children?.[1];
      const complete =
        /<\/a>$/i.test(first.value.trim()) ||
        (closing?.type === 'html' && closing.value.trim().toLowerCase() === '</a>');
      if (!complete) continue;
      const headingSlug = new GithubSlugger().slug(textContent(heading).trim());
      if (headingSlug !== attributes.id) continue;
      replacements.push({
        start: offset(paragraph.position.start, sourceName),
        end: offset(paragraph.position.end, sourceName),
        value: '',
      });
    }
    for (const child of children) inspect(child);
  }
  inspect(tree);
  return replacements;
}

function duplicateAnchorReplacements(tree, sourceName) {
  const seen = new Set();
  const replacements = [];
  const warnings = [];
  visit(tree, 'heading', (node) => {
    for (let index = 0; index < (node.children ?? []).length; index += 1) {
      const anchor = explicitHeadingAnchor(node.children, index);
      if (!anchor) continue;
      if (seen.has(anchor.id)) {
        replacements.push({
          start: offset(node.children[index].position.start, sourceName),
          end: offset(node.children[index + anchor.count - 1].position.end, sourceName),
          value: '',
        });
        warnings.push(`${sourceName}: duplicate archived heading anchor #${anchor.id} used only on its first occurrence`);
      } else {
        seen.add(anchor.id);
      }
      index += anchor.count - 1;
    }
  });
  return { replacements, warnings };
}

function applyReplacements(source, replacements, sourceName) {
  const ordered = replacements.toSorted((left, right) => right.start - left.start || right.end - left.end);
  let previousStart = source.length + 1;
  let output = source;
  for (const replacement of ordered) {
    if (replacement.end > previousStart) {
      throw new Error(`${sourceName}: generated transformations overlap`);
    }
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return output;
}

function normalizeDuplicateAnchors(source, sourceName) {
  const tree = parser.parse(source);
  const { replacements, warnings } = duplicateAnchorReplacements(tree, sourceName);
  replacements.push(...redundantStandaloneAnchorReplacements(tree, sourceName));
  return { source: applyReplacements(source, replacements, sourceName), warnings };
}

function headingDetails(tree, sourceName) {
  const slugger = new GithubSlugger();
  const headings = [];
  visit(tree, 'heading', (node) => {
    const explicit = [];
    const excluded = new Set();
    for (let index = 0; index < (node.children ?? []).length; index += 1) {
      const anchor = explicitHeadingAnchor(node.children, index);
      if (!anchor) continue;
      explicit.push(anchor.id);
      for (let count = 0; count < anchor.count; count += 1) excluded.add(index + count);
      index += anchor.count - 1;
    }
    if (explicit.length > 1) throw new Error(`${sourceName}: heading has more than one explicit anchor`);
    const rawTitle = textContent({
      ...node,
      children: (node.children ?? []).filter((_, index) => !excluded.has(index)),
    });
    const title = rawTitle.trim();
    if (!title) throw new Error(`${sourceName}: heading text must not be empty`);
    headings.push({ node, depth: node.depth, text: title, id: explicit[0] ?? slugger.slug(rawTitle) });
  });
  return headings;
}

function standaloneAnchors(tree) {
  const anchors = [];
  visit(tree, 'html', (node) => {
    for (const match of node.value.matchAll(/<a\s+[^>]*\bid=(["'])(.*?)\1[^>]*>/gi)) {
      anchors.push(match[2]);
    }
  });
  return anchors;
}

function pageLabel(sourceName, frontmatter, headings) {
  if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) return frontmatter.title.trim();
  const h1 = headings.find((heading) => heading.depth === 1);
  if (h1) return h1.text;
  return path.posix.basename(sourceName, '.md').replaceAll('-', ' ');
}

function localReferences(tree) {
  const references = [];
  visit(tree, (node) => {
    if (['link', 'image', 'definition'].includes(node.type) && typeof node.url === 'string') {
      references.push(node.url);
    }
    if (node.type === 'html') {
      for (const match of node.value.matchAll(HTML_REFERENCE)) references.push(match.groups.url);
    }
  });
  return references;
}


function splitReference(url) {
  const hashAt = url.indexOf('#');
  const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = beforeHash.indexOf('?');
  return {
    pathname: queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash,
    query: queryAt >= 0 ? beforeHash.slice(queryAt) : '',
    fragment,
  };
}

function decodedPathname(sourceName, pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new Error(`${sourceName}: invalid percent-encoding in reference: ${pathname}`);
  }
}

function collectReferencedSupportPaths(pages, pageSources) {
  const references = new Set();
  for (const page of pages) {
    for (const reference of localReferences(page.tree)) {
      if (isExternalReference(reference) || reference.startsWith('#')) continue;
      const { pathname } = splitReference(reference);
      if (!pathname) continue;
      const target = localTarget(page.sourceName, decodedPathname(page.sourceName, pathname));
      if (target === '.') continue;
      if (target.endsWith('.md')) {
        if (!pageSources.has(target)) {
          throw new Error(
            `${page.sourceName}: local Markdown page ${target} is not listed in toc.yml; add it to toc.yml or link to its repository URL`,
          );
        }
        continue;
      }
      const directory = target.replace(/\/+$/, '');
      if ([...pageSources].some((source) => source.startsWith(`${directory}/`))) continue;
      references.add(target);
    }
    for (const { requirement } of flattenRequirements(page.frontmatter.requirements)) {
      for (const [field, value] of [
        ['contract', requirement?.contract],
        ['test', requirement?.test],
      ]) {
        if (typeof value !== 'string' || /^[A-Za-z][A-Za-z+.-]*:/.test(value) || value.startsWith('//')) continue;
        const { pathname } = splitReference(value);
        if (!pathname) continue;
        const target = safeRelativeTarget(
          page.sourceName,
          decodedPathname(page.sourceName, pathname),
          '.',
        );
        if (target.endsWith('.md')) {
          if (!pageSources.has(target)) {
            throw new Error(
              `${page.sourceName}: requirement ${field} Markdown page ${target} is not listed in toc.yml`,
            );
          }
          continue;
        }
        references.add(target);
      }
    }
  }
  return references;
}

function assertReferencedSupportPathsAllowed(referencedPaths) {
  for (const reference of referencedPaths) {
    if (!isPublishableSupportPath(reference)) {
      throw new Error(`Refusing referenced hidden operational/config path: ${reference}`);
    }
  }
}

function referencedSupportPathIncludes(relative, referencedPaths) {
  const normalized = relative.replace(/\/+$/, '');
  return [...referencedPaths].some((reference) => {
    const candidate = reference.replace(/\/+$/, '');
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

function rewriteReference({ url, sourceName, pageRoutes, pageAnchors, base }) {
  if (isExternalReference(url)) return url;
  if (url.startsWith('#')) {
    const id = decodeURIComponent(url.slice(1));
    if (id && !pageAnchors.get(sourceName)?.has(id)) {
      throw new Error(`${sourceName}: unknown fragment ${url}`);
    }
    return url;
  }
  const { pathname, query, fragment } = splitReference(url);
  const target = localTarget(sourceName, pathname);
  if (target === '.') return `${baseUrl(base)}${query}${fragment}`;
  if (pageRoutes.has(target)) {
    if (fragment) {
      const id = decodeURIComponent(fragment.slice(1));
      if (id && !pageAnchors.get(target)?.has(id)) {
        throw new Error(`${sourceName}: unknown fragment ${fragment} on ${target}`);
      }
    }
    const route = pageRoutes.get(target);
    return `${baseUrl(base, route ? `${route}/` : '')}${query}${fragment}`;
  }
  if (pathname.endsWith('/')) {
    const directory = target.replace(/\/+$/, '');
    const first = [...pageRoutes.entries()].find(([page]) => page.startsWith(`${directory}/`));
    if (first) return `${baseUrl(base, first[1] ? `${first[1]}/` : '')}${query}${fragment}`;
  }
  return `${baseUrl(base, target)}${query}${fragment}`;
}

function destinationRange(source, node, sourceName) {
  const start = offset(node.position.start, sourceName);
  const end = offset(node.position.end, sourceName);
  const markdown = source.slice(start, end);
  const opener = node.type === 'image' ? markdown.lastIndexOf('](') : markdown.lastIndexOf('](');
  if (opener < 0) throw new Error(`${sourceName}: only inline references are supported for ${node.url}`);
  let relativeStart = opener + 2;
  while (/\s/.test(markdown[relativeStart] ?? '')) relativeStart += 1;
  if (markdown[relativeStart] === '<') relativeStart += 1;
  const relativeEnd = relativeStart + node.url.length;
  if (markdown.slice(relativeStart, relativeEnd) !== node.url) {
    throw new Error(`${sourceName}: could not safely locate reference ${node.url}`);
  }
  return { start: start + relativeStart, end: start + relativeEnd };
}

function referenceReplacements({ tree, source, sourceName, pageRoutes, pageAnchors, base }) {
  const replacements = [];
  visit(tree, (node) => {
    if (node.type === 'link' || node.type === 'image') {
      const rewritten = rewriteReference({ url: node.url, sourceName, pageRoutes, pageAnchors, base });
      if (rewritten !== node.url) {
        replacements.push({ ...destinationRange(source, node, sourceName), value: rewritten });
      }
      return;
    }
    if (node.type !== 'html') return;
    const rewritten = node.value.replace(HTML_REFERENCE, (...arguments_) => {
      const groups = arguments_.at(-1);
      const url = rewriteReference({
        url: groups.url,
        sourceName,
        pageRoutes,
        pageAnchors,
        base,
      });
      return `${groups.attribute}=${groups.quote}${url}${groups.quote}`;
    });
    if (rewritten !== node.value) {
      replacements.push({
        start: offset(node.position.start, sourceName),
        end: offset(node.position.end, sourceName),
        value: rewritten,
      });
    }
  });
  return replacements;
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineHtml(value) {
  const source = String(value ?? '');
  const parts = source.split(/(`[^`]+`)/g);
  return parts
    .map((part) =>
      part.startsWith('`') && part.endsWith('`')
        ? `<code>${htmlEscape(part.slice(1, -1))}</code>`
        : htmlEscape(part).replaceAll('\n', '<br>'),
    )
    .join('');
}

function documentationSections(documentation = '') {
  const sections = [];
  let active;
  for (const line of String(documentation).trim().split('\n')) {
    const match = DOCUMENTATION_LABEL.exec(line.trim());
    if (match) {
      active = { label: match[1], lines: [match[2]] };
      sections.push(active);
    } else if (active) {
      active.lines.push(line);
    } else if (line.trim()) {
      active = { label: 'Documentation', lines: [line] };
      sections.push(active);
    }
  }
  return sections.map((section) => ({
    label: section.label,
    content: section.lines.join('\n').trim(),
  }));
}

function rootReference(value, pageRoutes, base) {
  const { query, fragment, ...parts } = splitReference(value);
  const pathname = parts.pathname.replace(/^\/+/, '');
  if (pageRoutes.has(pathname)) {
    const route = pageRoutes.get(pathname);
    return `${baseUrl(base, route ? `${route}/` : '')}${query}${fragment}`;
  }
  return `${baseUrl(base, pathname)}${query}${fragment}`;
}

function asNames(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

// A condition, option key or extension id, linked to its view when there is one.
function conditionChip(name, context) {
  const label = `<code>${htmlEscape(name)}</code>`;
  const anchor = context.keyView?.anchors.get(name);
  if (!anchor) return label;
  return `<a class="requirement-condition" href="${htmlEscape(`${context.keyView.href}#${anchor}`)}">${label}</a>`;
}

function conditionList(names, context) {
  return names.map((name) => conditionChip(name, context)).join(', ');
}

function profileHref(profile, context) {
  const route = context.pageRoutes.get(profile.introduction);
  return baseUrl(context.base, route ? `${route}/` : '');
}

function profileLink(id, context) {
  const profile = context.profilesById?.get(id);
  if (!profile) return `<code>${htmlEscape(id)}</code>`;
  return `<a href="${htmlEscape(profileHref(profile, context))}">${htmlEscape(profile.title)}</a>`;
}

function profileTypeLabel(profile) {
  return profile.type === 'CORE' ? 'Core' : 'Extension';
}

function conditionRow(field, names, context) {
  if (!names.length) return undefined;
  const label = names.length === 1 ? 'Applies when' : field === 'applies_when_all' ? 'Applies when all of' : 'Applies when any of';
  return [label, conditionList(names, context)];
}

// A contract or test: a source path links to its published page or file, a web URL
// links as written, and any other identifier, such as a specification URN, is shown
// as written without a link.
function referenceValue(value, context) {
  const text = String(value);
  const label = `<code>${htmlEscape(text)}</code>`;
  if (/^https?:\/\//i.test(text)) return `<a href="${htmlEscape(text)}">${label}</a>`;
  if (isExternalReference(text)) return label;
  return `<a href="${htmlEscape(rootReference(text, context.pageRoutes, context.base))}">${label}</a>`;
}

function requirementCard(requirement, anchor, context, parent) {
  const options = !parent && Array.isArray(requirement.options) ? requirement.options : [];
  const isVariationPoint = !parent && Boolean(requirement.select || options.length);
  const isOption = Boolean(parent || requirement.option_of);
  const extension = parent && requirement.extension ? String(requirement.extension) : '';
  const permanentId = requirement.id ? String(requirement.id) : 'Unnumbered draft';
  const kind = isVariationPoint ? 'Variation point' : isOption ? 'Option' : 'Requirement';
  const cssKind = kind.toLowerCase().replaceAll(' ', '-');
  const verification = verificationOf(requirement, { isVariationPoint, isExtensionOption: Boolean(extension) });
  const observability = observabilityWarning(requirement, verification, context.sourceName);
  if (observability) context.warnings.push(observability);
  if (verification.method === 'unclassified' && !requirement.option_of && !(requirement.select && !options.length)) {
    context.warnings.push(`${context.sourceName}: requirement ${requirement.id || `“${String(requirement.statement ?? '').slice(0, 60)}”`} has no interaction and is reported as unclassified`);
  }
  const key = requirement.key ? conditionChip(String(requirement.key), context).replace('<code>', '<code class="requirement-key">') : '';
  const badges = [
    ['Lifecycle', requirement.status],
    ['Level', requirement.level],
    ['Observability', verification.method === 'legacy' ? requirement.observability : undefined],
    ['Mutability', requirement.mutability],
    ['Interaction', requirement.interaction],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<span class="requirement-badge"><span>${htmlEscape(label)}</span>${htmlEscape(value)}</span>`,
    )
    .join('');
  const rows = [];
  if (isVariationPoint && options.length) {
    const min = requirement.select?.min ?? 1;
    const max = requirement.select?.max;
    rows.push([
      'Selection',
      htmlEscape(`Meet at least ${min} of its ${options.length} options${max !== undefined ? `, and declare at most ${max}` : ''}`),
    ]);
  } else if (requirement.select?.min !== undefined) {
    rows.push(['Minimum selections', htmlEscape(requirement.select.min)]);
  }
  if (requirement.option_of) {
    rows.push(['Option of', htmlEscape(requirement.option_of)]);
    rows.push(['Inherited option obligation', htmlEscape(`Selected option under ${requirement.option_of}`)]);
  }
  if (extension) rows.push(['Met by claiming', `${profileLink(extension, context)} extension`]);
  const presentedBy = asNames(requirement.presented_by);
  if (presentedBy.length) rows.push(['Presented by', conditionList(presentedBy, context)]);
  for (const field of ['applies_when', 'applies_when_all']) {
    const row = conditionRow(field, asNames(requirement[field]), context);
    if (row) rows.push(row);
  }
  if (verification.label) rows.push(['Verification', htmlEscape(verification.label)]);
  if (requirement.contract) rows.push(['Contract', referenceValue(requirement.contract, context)]);
  if (requirement.api_operation_id) rows.push(['Operation', `<code>${htmlEscape(requirement.api_operation_id)}</code>`]);
  if (requirement.test) rows.push(['Test', referenceValue(requirement.test, context)]);
  const rowMarkup = rows
    .map(([label, value]) => `<div><dt>${htmlEscape(label)}</dt><dd>${String(value)}</dd></div>`)
    .join('');

  const documentation = documentationSections(requirement.documentation ?? '');
  const visibleLabels = new Set(['Purpose', 'Prerequisite', 'Condition', 'Scope', 'Constraint', 'Documentation']);
  const visible = documentation
    .filter((section) => visibleLabels.has(section.label))
    .map((section) => {
      const css = section.label === 'Constraint' ? ' requirement-constraint' : '';
      return `<div class="requirement-documentation${css}"><div class="requirement-label">${htmlEscape(section.label)}</div><p>${inlineHtml(section.content)}</p></div>`;
    })
    .join('');
  const proof = documentation
    .filter((section) => !visibleLabels.has(section.label))
    .map(
      (section) =>
        `<div class="requirement-proof-section"><div class="requirement-label">${htmlEscape(section.label)}</div><p>${inlineHtml(section.content)}</p></div>`,
    )
    .join('');
  const proofMarkup = proof
    ? `<details class="requirement-proof"><summary>Evidence and verification</summary>${proof}</details>`
    : '';
  const optionMarkup = options.length
    ? `<div class="requirement-options" aria-label="Options">
${options.map((option, index) => requirementCard(option ?? {}, `${anchor}-option-${index + 1}`, context, requirement)).join('\n')}
</div>`
    : '';

  return `<article class="requirement-card ${cssKind}" id="${anchor}" aria-labelledby="${anchor}-title">
  <header class="requirement-card-header">
    <span class="requirement-kind">${kind}</span>
    <div class="requirement-card-title requirement-statement" id="${anchor}-title" role="heading" aria-level="${parent ? 4 : 3}">${inlineHtml(requirement.statement)}</div>
    <span class="requirement-draft-id">${htmlEscape(permanentId)}</span>
  </header>
  ${key ? `<div class="requirement-key-row"><span class="requirement-label">Key</span>${key}</div>` : ''}
  <div class="requirement-badges">${badges}</div>
  ${rowMarkup ? `<dl class="requirement-rows">${rowMarkup}</dl>` : ''}
  ${visible}
  ${proofMarkup}
  ${optionMarkup}
</article>`;
}

function capabilityTitles(ids, context) {
  return ids
    .map((id) => {
      const capability = context.capabilities.get(id);
      if (!capability) {
        context.warnings.push(`${context.sourceName}: realises ${id}, which is not a capability in metadata.yml`);
        return `<code>${htmlEscape(id)}</code>`;
      }
      return htmlEscape(capability.title ?? id);
    })
    .join(', ');
}

function functionalityMarkup(frontmatter, context) {
  const requirements = frontmatter.requirements ?? [];
  if (!requirements.length) return undefined;
  const facts = [];
  if (context.profile) {
    facts.push([
      'Conformance profile',
      `${profileLink(context.profile.id, context)} (${profileTypeLabel(context.profile).toLowerCase()})`,
    ]);
    if (frontmatter.conformance !== undefined || frontmatter.extension !== undefined) {
      context.warnings.push(`${context.sourceName}: conformance and extension are ignored; a functionality belongs to the conformance profile whose folder holds it`);
    }
  } else {
    if (frontmatter.conformance) facts.push(['Conformance', htmlEscape(frontmatter.conformance)]);
    if (frontmatter.conformance === 'EXTENSION') facts.push(['Type', 'Extension']);
    if (frontmatter.extension) facts.push(['Extension', htmlEscape(frontmatter.extension)]);
  }
  const realises = asNames(frontmatter.realises);
  if (realises.length) facts.splice(context.profile ? 1 : 0, 0, ['Capabilities', capabilityTitles(realises, context)]);
  for (const field of ['applies_when', 'applies_when_all']) {
    const row = conditionRow(field, asNames(frontmatter[field]), context);
    if (row) facts.push(row);
  }
  const factMarkup = facts
    .map(([label, value]) => `<div><dt>${htmlEscape(label)}</dt><dd>${value}</dd></div>`)
    .join('');
  const cards = requirements
    .map((requirement, index) => requirementCard(requirement ?? {}, `requirement-${index + 1}`, context))
    .join('\n');
  const optionCount = requirements.reduce(
    (total, requirement) => total + (Array.isArray(requirement?.options) ? requirement.options.length : 0),
    0,
  );
  const unnumbered = flattenRequirements(requirements).some(({ requirement }) => !requirement?.id);
  const counted = `${requirements.length} requirement${requirements.length === 1 ? '' : 's'}`;
  const optionText = optionCount ? `, and ${optionCount} option${optionCount === 1 ? '' : 's'} beneath its variation points` : '';
  return {
    summary: `<div class="functionality-summary">
  <p>${inlineHtml(String(frontmatter.description ?? '').trim())}</p>
  ${factMarkup ? `<dl>${factMarkup}</dl>` : ''}
</div>`,
    requirements: `## Requirements

<p class="requirements-introduction">This functionality defines ${counted}${optionText}.${unnumbered ? ' “Unnumbered draft” reflects the source metadata and does not invent a permanent requirement identifier.' : ''}</p>

<div class="requirements-list">
${cards}
</div>
`,
  };
}

// The facts of a conformance profile, from the front matter of its introduction.
function profileMarkup(profile, context) {
  const core = context.profiles.find((candidate) => candidate.type === 'CORE');
  const buildsOn = profile.type === 'CORE'
    ? 'Every conformant software solution meets this profile'
    : [core.id, ...profile.requires].map((id) => profileLink(id, context)).join(', ');
  const facts = [
    ['Type', profile.type === 'CORE' ? 'Core' : 'Extension'],
    ['Id', `<code>${htmlEscape(profile.id)}</code>`],
    [profile.type === 'CORE' ? 'Claimed by' : 'Builds on', buildsOn],
    ['Role', profile.role ? htmlEscape(profile.role) : ''],
    ['Reference architecture', profile.referenceArchitecture ? `<code>${htmlEscape(profile.referenceArchitecture)}</code>` : ''],
    ['Functionalities', htmlEscape(profile.functionalities.length)],
  ].filter(([, value]) => value);
  return `<div class="functionality-summary profile-summary">
  <p>${inlineHtml(profile.description)}</p>
  <dl>${facts.map(([label, value]) => `<div><dt>${htmlEscape(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
</div>`;
}

function markdownTableCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').trim();
}

function extensionMetadata(extension) {
  if (typeof extension === 'string') return extension;
  if (!extension || typeof extension !== 'object') return '';
  const title = typeof extension.title === 'string' ? extension.title.trim() : '';
  const id = typeof extension.id === 'string' ? extension.id.trim() : '';
  const identity = title && id ? `${title} (\`${id}\`)` : title || (id ? `\`${id}\`` : '');
  const description =
    typeof extension.description === 'string' ? extension.description.trim() : '';
  const requires = Array.isArray(extension.requires)
    ? extension.requires
    : typeof extension.requires === 'string'
      ? [extension.requires]
      : [];
  const requirement = requires.length
    ? `Requires: ${requires.map((value) => `\`${String(value)}\``).join(', ')}.`
    : '';
  return [identity, description, requirement].filter(Boolean).join(' ');
}

function extensionsMetadata(extensions) {
  const rendered = (extensions ?? []).map(extensionMetadata).filter(Boolean);
  return rendered.length ? rendered.join('<br>') : 'None declared';
}

function profilesTable(context) {
  const core = context.profiles.find((profile) => profile.type === 'CORE');
  const rows = context.profiles.map((profile) => {
    const href = profileHref(profile, context);
    const buildsOn = profile.type === 'CORE'
      ? ''
      : [core.id, ...profile.requires].map((id) => `\`${id}\``).join(', ');
    return `| [${markdownTableCell(profile.title)}](${href}) | \`${profile.id}\` | ${profileTypeLabel(profile)} | ${buildsOn} | ${markdownTableCell(profile.description)} |`;
  });
  return `## Conformance profiles

Every conformant software solution meets the core. A software solution may claim extensions in addition to it, and meets each extension it claims in full.

| Profile | Id | Type | Builds on | Description |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function homeMetadataMarkup(metadata, authors, context) {
  const versions = metadata.versions ?? [];
  const version = versions.find((item) => item.latest) ?? versions[0] ?? {};
  const facts = [
    ['Version', version.version ?? 'Unknown'],
    ['Release date', version.release_date ?? 'Not assigned'],
    ['Short description', version.short_description ?? ''],
    ['Specification URN', metadata.urn ?? ''],
    ['Owner group', metadata.owner_group ?? ''],
    ['Canonical URL', metadata.url ?? ''],
    ['Repository', metadata.repository ?? ''],
  ];
  if (context.profiles.length) {
    if (metadata.extensions !== undefined) {
      context.warnings.push('metadata.yml: extensions is ignored; conformance profiles are declared in the introduction.md of each profile folder');
    }
  } else {
    facts.push(['Extensions', extensionsMetadata(metadata.extensions)]);
  }
  const capabilities = (metadata.capabilities ?? [])
    .map(
      (capability) =>
        `### ${capability.title}\n\n**Key:** \`${capability.id}\`\n\n${capability.description}`,
    )
    .join('\n\n');
  const authorRows = (authors.authors ?? [])
    .map((author) => {
      const urn = markdownTableCell(author.urn);
      return `| ${markdownTableCell(author.name)} | ${markdownTableCell((author.roles ?? []).join(', '))} | ${urn ? `\`${urn}\`` : ''} |`;
    })
    .join('\n');
  return `<div class="spec-abstract">${inlineHtml(metadata.abstract)}</div>

## Specification metadata

| Field | Value |
| --- | --- |
${facts.map(([label, value]) => `| ${markdownTableCell(label)} | ${markdownTableCell(value)} |`).join('\n')}

${context.profiles.length ? profilesTable(context) : ''}
## Capabilities

${capabilities}

## Authors

| Name | Role | URN |
| --- | --- | --- |
${authorRows}
`;
}

// Redirect and download index pages keep the bare noindex unless the build is unofficial.
const supportRobots = (unofficial) => (unofficial ? robotsContent(true) : 'noindex');

function generatedFrontmatter({ title, description, pagefind, apiReference }, unofficial) {
  return `---\n${YAML.stringify({
    title,
    description,
    ...(pagefind === false ? { pagefind: false } : {}),
    ...(apiReference ? { tableOfContents: false, prev: false, next: false } : {}),
    head: [{ tag: 'meta', attrs: { name: 'robots', content: robotsContent(unofficial) } }],
  })}---\n\n`;
}

function transformBody({ page, pageRoutes, pageAnchors, base, metadata, authors, unofficial, context }) {
  const { sourceName, source, tree, frontmatter, headings, title } = page;
  const replacements = [];
  if (page.frontmatterNode) {
    replacements.push({
      start: offset(page.frontmatterNode.position.start, sourceName),
      end: offset(page.frontmatterNode.position.end, sourceName),
      value: '',
    });
  }
  const titleHeading = frontmatter.title ? undefined : headings.find((heading) => heading.depth === 1);
  if (titleHeading) {
    let end = offset(titleHeading.node.position.end, sourceName);
    if (source[end] === '\r' && source[end + 1] === '\n') end += 2;
    else if (source[end] === '\n') end += 1;
    replacements.push({
      start: offset(titleHeading.node.position.start, sourceName),
      end,
      value: `<a id="${htmlEscape(titleHeading.id)}"></a>\n\n`,
    });
  }
  for (const heading of headings) {
    if (heading.depth !== 1 || heading === titleHeading) continue;
    replacements.push({
      start: offset(heading.node.position.start, sourceName),
      end: offset(heading.node.position.start, sourceName) + 1,
      value: '##',
    });
  }
  if (!page.generated) {
    replacements.push(
      ...referenceReplacements({ tree, source, sourceName, pageRoutes, pageAnchors, base }),
    );
  }
  let body = applyReplacements(source, replacements, sourceName).replace(/^\s+/, '');
  if (page.compatibilityAnchors?.size) {
    body = `${[...page.compatibilityAnchors].map((id) => `<a id="${htmlEscape(id)}"></a>`).join('\n')}\n\n${body}`;
  }
  const pageContext = { ...context, sourceName, profile: profileForSource(context.profiles, sourceName) };
  const profile = context.profiles.find((candidate) => candidate.introduction === sourceName);
  if (profile) body = `${profileMarkup(profile, pageContext)}\n\n${body}`;
  const functionality = profile ? undefined : functionalityMarkup(frontmatter, pageContext);
  if (functionality) {
    body = [functionality.summary, body, functionality.requirements].filter(Boolean).join('\n\n');
  }
  if (sourceName === 'README.md') body = `${homeMetadataMarkup(metadata, authors, context)}\n\n${body}`;
  const isArchive = sourceName.startsWith('resources/history/') || sourceName.includes('/legacy/');
  if (isArchive) {
    body = `:::caution[Archived source]\nThis page preserves historical material and is not current conformance text.\n:::\n\n${body}`;
  }
  const description =
    typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : sourceName === 'README.md'
        ? metadata.abstract
        : `${title} in the ${metadata.name} specification.`;
  return `${generatedFrontmatter({ title, description, pagefind: isArchive ? false : undefined }, unofficial)}${body}`;
}

function sectionLabel(section) {
  const words = section.replaceAll('-', ' ').replaceAll('_', ' ');
  return words[0].toUpperCase() + words.slice(1);
}

function sidebarFromToc(tocModel, pagesBySource, { profiles, keyView }) {
  const sidebar = [{ label: 'Home', slug: '' }];
  const link = (source, label) => {
    const page = pagesBySource.get(source);
    return { label: label ?? page.title, slug: page.route };
  };
  const item = (entry) => {
    if (entry.kind === 'page') return link(entry.source);
    if (entry.kind === 'folder') {
      // Starlight adds the base to sidebar links itself.
      return { label: `${path.posix.basename(entry.source)}/`, link: `/${entry.source}/` };
    }
    if (entry.kind === 'group') return { label: entry.label, items: entry.items.map(item) };
    const profile = profiles.find((candidate) => candidate.id === entry.id);
    return {
      label: profile.title,
      badge: { text: profile.type === 'CORE' ? 'Core' : 'Extension', variant: profile.type === 'CORE' ? 'note' : 'default' },
      items: entry.items.map((child) =>
        child.kind === 'page' && child.source === profile.introduction ? link(child.source, 'Introduction') : item(child),
      ),
    };
  };
  for (const section of tocModel.sections) {
    const items = section.items.map(item);
    if (section.key === PROFILE_SECTION && keyView) items.push({ label: keyView.title, slug: keyView.route });
    sidebar.push({ label: sectionLabel(section.key), items });
  }
  if (keyView && !tocModel.sections.some((section) => section.key === PROFILE_SECTION)) {
    sidebar.push({ label: keyView.title, slug: keyView.route });
  }
  return sidebar;
}

function sourceDigest(inputs) {
  const hash = createHash('sha256');
  for (const [source, contents] of [...inputs.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    const name = Buffer.from(source);
    hash.update(`${name.length}:`);
    hash.update(name);
    hash.update(`${contents.length}:`);
    hash.update(contents);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function gitSourceState(sourceRoot) {
  const [{ stdout: revision }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync('git', ['--no-optional-locks', '-C', sourceRoot, 'rev-parse', 'HEAD']),
    execFileAsync('git', [
      '--no-optional-locks',
      '-C',
      sourceRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]),
  ]);
  return { sourceRevision: revision.trim(), sourceDirty: statusOutput.trim() !== '' };
}

const SPECIFICATION_DOWNLOADS = ['toc.yml', 'metadata.yml', 'authors.yml'];
const STRUCTURED_SUPPORT_EXTENSIONS = new Set(['.yml', '.yaml', '.json']);

function schemaReferences(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) schemaReferences(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['$ref', '$dynamicRef'].includes(key) && typeof child === 'string') found.push(child);
      else schemaReferences(child, found);
    }
  }
  return found;
}

function parseSchemaReferences(relative, contents) {
  if (!STRUCTURED_SUPPORT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) return [];
  const text = contents.toString('utf8');
  if (!text.includes('$ref') && !text.includes('$dynamicRef')) return [];
  const options = { logLevel: 'error' };
  const documents = YAML.parseAllDocuments(text, options);
  const failure = documents.flatMap((document) => document.errors)[0];
  if (failure) throw failure;
  return documents.flatMap((document) => schemaReferences(document.toJS(options)));
}

function relativeSchemaTargets(relative, references) {
  const targets = [];
  for (const reference of references) {
    if (
      /^[A-Za-z][A-Za-z+.-]*:/.test(reference)
      || reference.startsWith('//')
      || reference.startsWith('/')
    ) {
      continue;
    }
    const { pathname } = splitReference(reference);
    if (pathname) {
      targets.push(safeRelativeTarget(relative, decodedPathname(relative, pathname)));
    }
  }
  return targets;
}

async function copySupportFiles(
  sourceRoot,
  siteRoot,
  pageSources,
  snapshots,
  referencedPaths,
  warnings,
) {
  const copied = new Set();
  const publicRoot = path.join(siteRoot, 'public');
  const sourceReal = await realpath(sourceRoot);
  const pending = [];
  const followed = new Set();
  const walking = new Set();

  async function publish(relative, contents, real, via, chain) {
    const posixRelative = relative.split(path.sep).join('/');
    if (copied.has(posixRelative)) return;
    const destination = path.join(publicRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    snapshots.set(posixRelative, contents);
    copied.add(posixRelative);

    const followKey = `${real}\0${path.posix.dirname(posixRelative)}`;
    if (followed.has(followKey)) return;
    followed.add(followKey);
    const chainKey = `${real}\0${path.dirname(real)}`;
    if (chain.has(chainKey)) {
      warnings.push(`${posixRelative}: symlink cycle, schema references are not followed`);
      return;
    }
    let references;
    try {
      references = parseSchemaReferences(posixRelative, contents);
    } catch (error) {
      const message = `${posixRelative}: cannot parse support file to follow schema references: ${error.message}`;
      if (via) throw new Error(`${message} (referenced from ${via})`);
      warnings.push(message);
      return;
    }
    for (const target of relativeSchemaTargets(posixRelative, references)) {
      pending.push({
        relative: target,
        from: posixRelative,
        chain: new Set(chain).add(chainKey),
      });
    }
  }

  async function walkDirectory(real, source, relative, via, chain) {
    if (walking.has(real)) {
      warnings.push(`${relative.split(path.sep).join('/')}: symlink cycle, directory is already being copied`);
      return;
    }
    walking.add(real);
    try {
      for (const entry of await readdir(source)) {
        await walk(path.join(source, entry), path.join(relative, entry), via, chain);
      }
    } finally {
      walking.delete(real);
    }
  }

  async function walk(source, relative, via, chain) {
    const posixRelative = relative.split(path.sep).join('/');
    if (!isPublishableSupportPath(posixRelative)) return;
    const details = await lstat(source);
    if (details.isSymbolicLink()) {
      const resolved = await realpath(source);
      if (resolved !== sourceReal && !resolved.startsWith(`${sourceReal}${path.sep}`)) {
        throw new Error(`Refusing source symlink outside repository: ${relative}`);
      }
      const resolvedRelative = path.relative(sourceReal, resolved).split(path.sep).join('/');
      if (!isPublishableSupportPath(resolvedRelative)) {
        if (referencedSupportPathIncludes(posixRelative, referencedPaths)) {
          throw new Error(
            `Refusing referenced support symlink ${posixRelative}: target is hidden operational/config path ${resolvedRelative}`,
          );
        }
        return;
      }
      const resolvedDetails = await stat(resolved);
      if (resolvedDetails.isDirectory()) {
        await walkDirectory(resolved, resolved, relative, via, chain);
      } else if (!posixRelative.endsWith('.md') && !pageSources.has(posixRelative)) {
        await publish(relative, await readFile(resolved), resolved, via, chain);
      }
      return;
    }
    if (details.isDirectory()) {
      await walkDirectory(await realpath(source), source, relative, via, chain);
      return;
    }
    if (posixRelative.endsWith('.md') || pageSources.has(posixRelative)) return;
    await publish(relative, await readFile(source), await realpath(source), via, chain);
  }

  async function copyEntry({ relative, from, chain = new Set() }) {
    const normalized = relative.replace(/\/+$/, '');
    if (!isPublishableSupportPath(normalized)) {
      throw new Error(
        `${from ? `${from}: ` : ''}Refusing referenced hidden operational/config path: ${normalized}`,
      );
    }
    const source = path.join(sourceRoot, normalized);
    let resolved;
    try {
      resolved = await realpath(source);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (from) {
        throw new Error(`${from}: schema reference target ${normalized} does not exist`);
      }
      return;
    }
    if (resolved !== sourceReal && !resolved.startsWith(`${sourceReal}${path.sep}`)) {
      throw new Error(`Refusing source symlink outside repository: ${normalized}`);
    }
    const resolvedRelative = path.relative(sourceReal, resolved).split(path.sep).join('/');
    if (!isPublishableSupportPath(resolvedRelative)) {
      throw new Error(
        `Refusing referenced support symlink ${normalized}: target is hidden operational/config path ${resolvedRelative}`,
      );
    }
    if (from && (await stat(resolved)).isDirectory()) {
      throw new Error(`${from}: schema reference target ${normalized} is a directory`);
    }
    await walk(source, normalized, from, chain);
  }

  for (const reference of [...new Set([...SPECIFICATION_DOWNLOADS, ...referencedPaths])].sort()) {
    pending.push({ relative: reference });
  }
  while (pending.length) await copyEntry(pending.shift());
  return [...copied].toSorted();
}

function redirectHtml(target, unofficial) {
  const encoded = JSON.stringify(target);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="${supportRobots(unofficial)}"><meta http-equiv="refresh" content="0;url=${htmlEscape(target)}"><title>Redirecting…</title></head><body data-pagefind-ignore><p><a href="${htmlEscape(target)}">Continue to the Starlight page</a></p><script>location.replace(${encoded} + location.search + location.hash);</script></body></html>\n`;
}

async function writeRedirects(siteRoot, pages, base, unofficial) {
  const redirects = [];
  for (const page of pages) {
    if (page.sourceName === 'README.md' || page.generated || !page.sourceName.endsWith('.md')) continue;
    const legacy = page.sourceName.replace(/\.md$/, '.html');
    const target = baseUrl(base, page.route ? `${page.route}/` : '');
    const output = path.join(siteRoot, 'public', legacy);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, redirectHtml(target, unofficial));
    redirects.push({ legacy, target });
  }
  return redirects;
}

async function writeSupportDirectoryIndexes(
  sourceRoot,
  siteRoot,
  pages,
  pageRoutes,
  base,
  referencedPaths,
  supportFiles,
  unofficial,
  listedFolders = [],
) {
  const indexes = [];
  const directories = new Set(listedFolders);
  const sourceReal = await realpath(sourceRoot);
  for (const page of pages) {
    for (const reference of localReferences(page.tree)) {
      if (isExternalReference(reference)) continue;
      const { pathname } = splitReference(reference);
      if (!pathname.endsWith('/')) continue;
      const target = localTarget(page.sourceName, pathname).replace(/\/+$/, '');
      if (target === '.') continue;
      if ([...pageRoutes.keys()].some((source) => source.startsWith(`${target}/`))) continue;
      try {
        const sourcePath = path.join(sourceRoot, target);
        const details = await lstat(sourcePath);
        if (details.isSymbolicLink()) {
          const resolved = await realpath(sourcePath);
          if (resolved !== sourceReal && !resolved.startsWith(`${sourceReal}${path.sep}`)) {
            throw new Error(`Refusing source symlink outside repository: ${target}`);
          }
          const resolvedRelative = path.relative(sourceReal, resolved).split(path.sep).join('/');
          if (!isPublishableSupportPath(resolvedRelative)) {
            if (referencedSupportPathIncludes(target, referencedPaths)) {
              throw new Error(
                `Refusing referenced support symlink ${target}: target is hidden operational/config path ${resolvedRelative}`,
              );
            }
            continue;
          }
          if ((await stat(resolved)).isDirectory()) directories.add(target);
        } else if (details.isDirectory()) {
          directories.add(target);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  for (const directory of [...directories].sort()) {
    const prefix = `${directory}/`;
    const links = supportFiles
      .filter((relative) => relative.startsWith(prefix))
      .map((relative) => {
        const label = relative.slice(prefix.length);
        return `<li><a href="${htmlEscape(baseUrl(base, relative))}">${htmlEscape(label)}</a></li>`;
      });
    const output = path.join(siteRoot, 'public', directory, 'index.html');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="${supportRobots(unofficial)}"><title>${htmlEscape(directory)} downloads</title></head><body data-pagefind-ignore><main><h1>${htmlEscape(directory)} downloads</h1><p>Source support files for the specification preview.</p><ul>${links.join('')}</ul></main></body></html>\n`,
    );
    indexes.push(`${directory}/index.html`);
  }
  return indexes;
}

async function pruneFormerGeneratedPages(siteRoot, currentPages) {
  const manifestPath = path.join(siteRoot, 'src/data/generated/spec.json');
  let previous;
  try {
    previous = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const currentBySource = new Map(currentPages.map((page) => [page.sourceName, page.route]));
  const docsRoot = path.resolve(siteRoot, 'src/content/docs');
  for (const page of previous.pages ?? []) {
    if (currentBySource.get(page.source) === page.route) continue;
    const relative = page.route ? `${page.route}.md` : 'index.md';
    const output = path.resolve(docsRoot, relative);
    if (output !== docsRoot && !output.startsWith(`${docsRoot}${path.sep}`)) {
      throw new Error(`Refusing to prune generated page outside content root: ${page.route}`);
    }
    try {
      await unlink(output);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function addArchiveCompatibilityAnchors(loaded, warnings) {
  const bySource = new Map(loaded.map((page) => [page.sourceName, page]));
  for (const page of loaded) {
    for (const reference of localReferences(page.tree)) {
      if (isExternalReference(reference)) continue;
      const { pathname, fragment } = splitReference(reference);
      if (!fragment) continue;
      const targetName = pathname ? localTarget(page.sourceName, pathname) : page.sourceName;
      const target = bySource.get(targetName);
      const id = decodeURIComponent(fragment.slice(1));
      if (!target || !id || target.anchors.has(id)) continue;
      if (!targetName.startsWith('resources/history/')) continue;
      target.compatibilityAnchors ??= new Set();
      target.compatibilityAnchors.add(id);
      target.anchors.add(id);
      warnings.push(`${targetName}: retained archived inbound fragment #${id} as a compatibility anchor`);
    }
  }
}

const KEY_VIEW_TITLE = 'Options and conditions';

function pageHref(page, base, anchor) {
  return `${baseUrl(base, page.route ? `${page.route}/` : '')}${anchor ? `#${anchor}` : ''}`;
}

function htmlLink(href, label) {
  return `<a href="${htmlEscape(href)}">${label}</a>`;
}

// The views by key of ARCH-ADR-6: for every option key and extension profile, the
// requirements whose applies_when names it, grouped by functionality. It is
// generated from the functionality files, so it never disagrees with them, and it
// is informative: conformance is still assessed per requirement.
function keyViewPage({ conditions, profiles, pageRoutes, base, metadata }) {
  const entries = [...conditions.values()];
  const options = entries.filter((entry) => entry.kind === 'option');
  if (!options.length && !entries.some((entry) => entry.uses.length)) return undefined;
  const route = profiles.length ? `${PROFILE_SECTION}/options-and-conditions` : 'options-and-conditions';
  const slugger = new GithubSlugger();
  const anchors = new Map();
  const profileOf = (page) => profileForSource(profiles, page.sourceName);
  const profileLabel = (profile) =>
    profile ? `${htmlLink(baseUrl(base, `${pageRoutes.get(profile.introduction)}/`), htmlEscape(profile.title))} (${profile.type === 'CORE' ? 'core' : 'extension'})` : '';

  function usesTable(entry) {
    if (!entry.uses.length) return '<p class="key-view-empty">No requirement names it in <code>applies_when</code>.</p>';
    const rows = entry.uses.map((use) => {
      const requirement = use.requirement;
      const statement = requirement
        ? htmlLink(pageHref(use.page, base, use.anchor), inlineHtml(requirement.statement))
        : `Every requirement of ${htmlLink(pageHref(use.page, base), htmlEscape(use.page.title))}`;
      const field = use.mode === 'all' ? 'applies_when_all' : 'applies_when';
      const names = asNames((requirement ?? use.page.frontmatter)[field]);
      const condition = names.length === 1 ? '' : use.mode === 'all' ? 'all of ' : 'any of ';
      return `<tr><td>${statement}</td><td>${htmlLink(pageHref(use.page, base), htmlEscape(use.page.title))}</td><td>${htmlEscape(requirement?.level ?? '')}</td><td>${condition}${names.map((name) => `<code>${htmlEscape(name)}</code>`).join(', ')}</td></tr>`;
    });
    return `<table class="key-view-table"><thead><tr><th>Requirement</th><th>Functionality</th><th>Level</th><th>Applies when</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  const sections = [
    `<p>Each option of a variation point that other requirements refer to has a key. A requirement whose <code>applies_when</code> names a key, or the id of an extension profile, applies only to a software solution that meets that option or claims that extension. Otherwise it is reported as not applicable, neither passed nor failed. This page lists them by key. It is generated from the functionality files and adds no requirement of its own.</p>`,
  ];
  if (options.length) {
    sections.push('## Options');
    slugger.slug('Options');
    for (const entry of options) {
      sections.push(`### ${entry.name}`);
      anchors.set(entry.name, slugger.slug(entry.name));
      const variationAnchor = entry.anchor.replace(/-option-\d+$/, '');
      const id = entry.requirement.id ? `Option ${htmlEscape(entry.requirement.id)} of the` : 'An option of the';
      const where = [htmlLink(pageHref(entry.page, base), htmlEscape(entry.page.title)), profileLabel(profileOf(entry.page))].filter(Boolean).join(', ');
      const extension = entry.requirement.extension ? profiles.find((profile) => profile.id === String(entry.requirement.extension)) : undefined;
      sections.push(
        `<p class="key-view-definition">${id} variation point ${htmlLink(pageHref(entry.page, base, variationAnchor), `“${inlineHtml(entry.parent.statement)}”`)} in ${where}.</p>`,
        `<blockquote><p>${htmlLink(pageHref(entry.page, base, entry.anchor), inlineHtml(entry.requirement.statement))}</p></blockquote>`,
        ...(extension ? [`<p>It is met by claiming the ${htmlLink(baseUrl(base, `${pageRoutes.get(extension.introduction)}/`), htmlEscape(extension.title))} extension.</p>`] : []),
        usesTable(entry),
      );
    }
  }
  const extensions = entries.filter((entry) => entry.kind === 'extension' && (entry.uses.length || options.some((option) => String(option.requirement.extension ?? '') === entry.name)));
  if (extensions.length) {
    sections.push('## Extensions');
    slugger.slug('Extensions');
    for (const entry of extensions) {
      sections.push(`### ${entry.name}`);
      anchors.set(entry.name, slugger.slug(entry.name));
      sections.push(
        `<p class="key-view-definition">Claiming the ${htmlLink(baseUrl(base, `${pageRoutes.get(entry.profile.introduction)}/`), htmlEscape(entry.profile.title))} extension. Its own functionalities apply in full; the requirements below sit in other functionalities and apply only when it is claimed.</p>`,
        usesTable(entry),
      );
    }
  }
  const source = `${sections.join('\n\n')}\n`;
  const sourceName = `${route}.md`;
  const tree = parser.parse(source);
  const headings = headingDetails(tree, sourceName);
  for (const [name, anchor] of anchors) {
    if (!headings.some((heading) => heading.id === anchor)) throw new Error(`${sourceName}: generated anchor #${anchor} for ${name} is missing`);
  }
  return {
    title: KEY_VIEW_TITLE,
    route,
    href: baseUrl(base, `${route}/`),
    anchors,
    page: {
      sourceName,
      source,
      tree,
      frontmatterNode: undefined,
      frontmatter: {
        title: KEY_VIEW_TITLE,
        description: `What follows from each option and extension of ${metadata.name}, by key.`,
      },
      headings,
      title: KEY_VIEW_TITLE,
      route,
      anchors: new Set(headings.map((heading) => heading.id)),
      generated: true,
    },
  };
}

export async function generateSite({ sourceRoot, siteRoot, base = '/', unofficial = false }) {
  if (!sourceRoot || !siteRoot) throw new Error('generateSite requires sourceRoot and siteRoot');
  const absoluteSourceRoot = await realpath(path.resolve(sourceRoot));
  const absoluteSiteRoot = path.resolve(siteRoot);
  const normalizedBase = normalizeBase(base);
  const tocBuffer = await readFile(path.join(absoluteSourceRoot, 'toc.yml'));
  const metadataBuffer = await readFile(path.join(absoluteSourceRoot, 'metadata.yml'));
  const authorsBuffer = await readFile(path.join(absoluteSourceRoot, 'authors.yml'));
  const toc = YAML.parse(tocBuffer.toString('utf8'))?.toc;
  const metadata = YAML.parse(metadataBuffer.toString('utf8'));
  const authors = YAML.parse(authorsBuffer.toString('utf8'));
  if (!toc || typeof toc !== 'object') throw new Error('toc.yml: toc mapping is required');
  if (!metadata?.name || !Array.isArray(metadata.versions)) {
    throw new Error('metadata.yml: name and versions are required');
  }
  if (!Array.isArray(authors?.authors)) throw new Error('authors.yml: authors list is required');

  const tocModel = parseToc(toc);
  const { ordered, pageSources } = tocModel;
  const warnings = [];
  const loaded = [];
  const snapshots = new Map([
    ['toc.yml', tocBuffer],
    ['metadata.yml', metadataBuffer],
    ['authors.yml', authorsBuffer],
  ]);
  let requirementCount = 0;
  const linkedDecisionRecords = [];
  // ordered grows while it is read, as linked decision records are found.
  for (const sourceName of ordered) {
    const sourceBuffer = await readFile(path.join(absoluteSourceRoot, sourceName));
    snapshots.set(sourceName, sourceBuffer);
    // terminology.yml and references.yml are rendered from their data; the source bytes stay in the digest.
    const yaml = /\.ya?ml$/i.test(sourceName) ? yamlPage(sourceName, sourceBuffer.toString('utf8')) : undefined;
    const normalized = normalizeDuplicateAnchors(yaml ? yaml.markdown : sourceBuffer.toString('utf8'), sourceName);
    warnings.push(...normalized.warnings);
    const source = normalized.source;
    const tree = parser.parse(source);
    const { node: frontmatterNode, value: frontmatter } = sourceFrontmatter(tree);
    const headings = headingDetails(tree, sourceName);
    const title = yaml?.title ?? pageLabel(sourceName, frontmatter, headings);
    const route = routeFor(sourceName);
    const anchors = new Set([...headings.map((heading) => heading.id), ...standaloneAnchors(tree)]);
    // Decision records are not yet part of toc.yml. One that a published page links to
    // is published as a resource, so that the link resolves; it is followed in turn.
    for (const reference of localReferences(tree)) {
      if (isExternalReference(reference) || reference.startsWith('#')) continue;
      const { pathname } = splitReference(reference);
      if (!pathname.endsWith('.md')) continue;
      const target = localTarget(sourceName, decodedPathname(sourceName, pathname));
      if (!target.startsWith('ADR/') || pageSources.has(target)) continue;
      try {
        if (!(await stat(path.join(absoluteSourceRoot, target))).isFile()) continue;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      ordered.push(target);
      pageSources.add(target);
      linkedDecisionRecords.push(target);
      warnings.push(`${target}: not listed in toc.yml; published under resources because ${sourceName} links to it`);
    }
    requirementCount += flattenRequirements(frontmatter.requirements).length;
    loaded.push({
      sourceName,
      source,
      tree,
      frontmatterNode,
      frontmatter,
      headings,
      title,
      route,
      anchors,
    });
  }
  if (linkedDecisionRecords.length) {
    let resources = tocModel.sections.find((section) => section.key === 'resources');
    if (!resources) {
      resources = { key: 'resources', items: [] };
      tocModel.sections.push(resources);
    }
    resources.items.push(...linkedDecisionRecords.map((source) => ({ kind: 'page', source })));
  }
  const pagesBySource = new Map(loaded.map((page) => [page.sourceName, page]));
  const profiles = resolveProfiles(tocModel.profiles, pagesBySource, warnings);
  for (const profile of profiles) {
    // A profile is cited by its folder name, so its introduction is served at the folder's route.
    const page = pagesBySource.get(profile.introduction);
    page.route = page.route.replace(/\/introduction$/, '');
  }
  if (profiles.length && tocModel.sections.some((section) => section.key === 'requirements')) {
    warnings.push('toc.yml: requirements is replaced by conformance-profiles; list every functionality under its profile');
  }
  addArchiveCompatibilityAnchors(loaded, warnings);
  const pageRoutes = new Map(loaded.map((page) => [page.sourceName, page.route]));
  const pageAnchors = new Map(loaded.map((page) => [page.sourceName, page.anchors]));
  for (const profile of profiles) {
    const page = pagesBySource.get(profile.introduction);
    const targets = localReferences(page.tree)
      .filter((reference) => !isExternalReference(reference) && !reference.startsWith('#'))
      .map((reference) => splitReference(reference).pathname)
      .filter((pathname) => pathname.endsWith('.md'))
      .map((pathname) => localTarget(page.sourceName, decodedPathname(page.sourceName, pathname)));
    checkProfileFunctionalityLinks(profile, targets, warnings);
  }
  const functionalityPages = loaded.filter((page) => page.frontmatter.requirements?.length);
  for (const page of functionalityPages) checkOptions(page, profileForSource(profiles, page.sourceName), warnings);
  const conditions = collectConditions(functionalityPages, profiles, warnings);
  const keyView = keyViewPage({ conditions, profiles, pageRoutes, base: normalizedBase, metadata, warnings });
  const referencedSupportPaths = collectReferencedSupportPaths(loaded, pageSources);
  for (const folder of tocModel.folders) {
    let details;
    try {
      details = await stat(path.join(absoluteSourceRoot, folder));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!details?.isDirectory()) {
      throw new Error(`toc.yml: the folder entry ${path.posix.basename(folder)}/ resolves to ${folder}/, which is not a folder in the source`);
    }
    referencedSupportPaths.add(folder);
  }
  assertReferencedSupportPathsAllowed(referencedSupportPaths);
  const supportFiles = await copySupportFiles(
    absoluteSourceRoot,
    absoluteSiteRoot,
    pageSources,
    snapshots,
    referencedSupportPaths,
    warnings,
  );
  const apiReferences = await prepareApiReferences({
    sourceRoot: absoluteSourceRoot,
    siteRoot: absoluteSiteRoot,
    base: normalizedBase,
    unofficial,
    snapshots,
    reservedPaths: supportFiles,
  });
  for (const reference of apiReferences.references) {
    const page = pagesBySource.get(reference.page);
    if (!page) throw new Error(`api-references.yml: page is not in the source navigation: ${reference.page}`);
    reference.title = page.title;
    reference.route = page.route;
  }
  if (keyView) {
    if ([...pageRoutes.values()].includes(keyView.route)) {
      throw new Error(`${keyView.route}: a source page already uses the route of the generated ${keyView.title} page`);
    }
    loaded.push(keyView.page);
    pageRoutes.set(keyView.page.sourceName, keyView.route);
  }
  const sidebar = apiReferenceSidebar(
    sidebarFromToc(tocModel, pagesBySource, { profiles, keyView }),
    apiReferences.references,
    pagesBySource,
  );
  const renderContext = {
    pageRoutes,
    base: normalizedBase,
    profiles,
    profilesById: new Map(profiles.map((profile) => [profile.id, profile])),
    capabilities: new Map((metadata.capabilities ?? []).map((capability) => [String(capability.id), capability])),
    keyView,
    warnings,
  };

  await pruneFormerGeneratedPages(absoluteSiteRoot, loaded);

  for (const page of loaded) {
    let output = transformBody({
      page,
      pageRoutes,
      pageAnchors,
      base: normalizedBase,
      metadata,
      authors,
      unofficial,
      context: renderContext,
    });
    const reference = apiReferences.references.find((item) => item.page === page.sourceName);
    if (reference) {
      output = generatedFrontmatter({ title: page.title, description: page.frontmatter.description, apiReference: true }, unofficial)
        + page.headings.map((heading) => `<a id="${htmlEscape(heading.id)}"></a>`).join('\n')
        + '\n' + apiReferenceMarkup(reference);
    }
    const relative = page.route ? `${page.route}.md` : 'index.md';
    const destination = path.join(absoluteSiteRoot, 'src/content/docs', relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, output);
  }

  const supportIndexes = await writeSupportDirectoryIndexes(
    absoluteSourceRoot,
    absoluteSiteRoot,
    loaded,
    pageRoutes,
    normalizedBase,
    referencedSupportPaths,
    supportFiles,
    unofficial,
    tocModel.folders,
  );
  const redirects = await writeRedirects(absoluteSiteRoot, loaded, normalizedBase, unofficial);
  const sourceState = await gitSourceState(absoluteSourceRoot);
  const version = (metadata.versions.find((item) => item.latest) ?? metadata.versions[0]).version;
  const manifest = {
    title: metadata.name,
    version,
    repository: metadata.repository,
    canonicalUrl: metadata.url,
    sourceDigest: sourceDigest(snapshots),
    requirementCount,
    sidebar,
    supportFiles: [...new Set([...supportFiles, ...apiReferences.supportFiles])].toSorted(),
    apiReferences: apiReferences.references,
    supportIndexes,
    redirects,
    warnings: [...new Set(warnings)],
    ...sourceState,
    pages: loaded.map((page) => ({
      source: page.sourceName,
      route: page.route,
      title: page.title,
      anchors: [...page.anchors].map((id) => ({ id })),
      ...(page.generated ? { generated: true } : {}),
    })),
    profiles: profiles.map((profile) => ({
      id: profile.id,
      type: profile.type,
      title: profile.title,
      requires: profile.requires,
      route: pageRoutes.get(profile.introduction),
      functionalities: profile.functionalities,
    })),
  };
  const manifestPath = path.join(absoluteSiteRoot, 'src/data/generated/spec.json');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}


