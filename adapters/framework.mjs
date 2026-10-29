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

import GithubSlugger from 'github-slugger';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import YAML from 'yaml';

import { robotsContent } from '../scripts/publication.mjs';
import { isPublishableSupportPath } from '../scripts/support-paths.mjs';

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
    : source.slice(0, -'.md'.length);
  return route
    .split('/')
    .map((segment) => segment.replaceAll('.', ''))
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

function safeRelativeTarget(sourceName, target) {
  const pathname = target.split(/[?#]/, 1)[0];
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(sourceName), pathname));
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${sourceName}: relative reference escapes the source root: ${target}`);
  }
  return normalized;
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

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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
    if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string') {
      references.push(node.url);
    }
    if (node.type === 'html') {
      for (const match of node.value.matchAll(HTML_REFERENCE)) references.push(match.groups.url);
    }
  });
  return references;
}

async function discoverPages(sourceRoot, toc) {
  const ordered = ['README.md'];
  for (const [section, entries] of Object.entries(toc)) {
    ordered.push(...entries.map((entry) => path.posix.join(section, entry)));
  }
  const pages = new Set(ordered);
  const queue = [...ordered];
  while (queue.length) {
    const sourceName = queue.shift();
    const source = await readFile(path.join(sourceRoot, sourceName), 'utf8');
    const tree = parser.parse(source);
    for (const reference of localReferences(tree)) {
      if (/^[A-Za-z][A-Za-z+.-]*:/.test(reference) || reference.startsWith('//') || reference.startsWith('#')) continue;
      const target = safeRelativeTarget(sourceName, reference);
      if (!target.endsWith('.md') || pages.has(target)) continue;
      if (await exists(path.join(sourceRoot, target))) {
        pages.add(target);
        queue.push(target);
      }
    }
  }
  return { ordered: [...ordered, ...[...pages].filter((page) => !ordered.includes(page)).sort()], pages };
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

function collectReferencedSupportPaths(pages) {
  const references = new Set();
  for (const page of pages) {
    for (const reference of localReferences(page.tree)) {
      if (
        /^[A-Za-z][A-Za-z+.-]*:/.test(reference) ||
        reference.startsWith('//') ||
        reference.startsWith('/') ||
        reference.startsWith('#')
      ) {
        continue;
      }
      const { pathname } = splitReference(reference);
      if (pathname) references.add(safeRelativeTarget(page.sourceName, pathname));
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
  if (/^[A-Za-z][A-Za-z+.-]*:/.test(url) || url.startsWith('//') || url.startsWith('/')) return url;
  if (url.startsWith('#')) {
    const id = decodeURIComponent(url.slice(1));
    if (id && !pageAnchors.get(sourceName)?.has(id)) {
      throw new Error(`${sourceName}: unknown fragment ${url}`);
    }
    return url;
  }
  const { pathname, query, fragment } = splitReference(url);
  const target = safeRelativeTarget(sourceName, pathname);
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
  const { pathname, query, fragment } = splitReference(value);
  if (pageRoutes.has(pathname)) {
    const route = pageRoutes.get(pathname);
    return `${baseUrl(base, route ? `${route}/` : '')}${query}${fragment}`;
  }
  return `${baseUrl(base, pathname)}${query}${fragment}`;
}

function requirementCard(requirement, index, pageRoutes, base) {
  const permanentId = requirement.id ? String(requirement.id) : 'Unnumbered draft';
  const key = requirement.key ? `<code class="requirement-key">${htmlEscape(requirement.key)}</code>` : '';
  const kind = requirement.select ? 'Variation point' : requirement.option_of ? 'Option' : 'Requirement';
  const cssKind = kind.toLowerCase().replaceAll(' ', '-');
  const badges = [
    ['Lifecycle', requirement.status],
    ['Level', requirement.level],
    ['Observability', requirement.observability],
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
  if (requirement.select?.min !== undefined) rows.push(['Minimum selections', requirement.select.min]);
  if (requirement.option_of) {
    rows.push(['Option of', requirement.option_of]);
    rows.push(['Inherited option obligation', `Selected option under ${requirement.option_of}`]);
  }
  if (requirement.applies_when) rows.push(['Any of', requirement.applies_when.join(', ')]);
  if (requirement.applies_when_all) rows.push(['All of', requirement.applies_when_all.join(', ')]);
  if (requirement.contract) {
    const href = rootReference(requirement.contract, pageRoutes, base);
    rows.push(['Contract', `<a href="${htmlEscape(href)}"><code>${htmlEscape(requirement.contract)}</code></a>`]);
  }
  if (requirement.api_operation_id) rows.push(['Operation', `<code>${htmlEscape(requirement.api_operation_id)}</code>`]);
  if (requirement.test) {
    const href = rootReference(requirement.test, pageRoutes, base);
    rows.push(['Test', `<a href="${htmlEscape(href)}"><code>${htmlEscape(requirement.test)}</code></a>`]);
  }
  const rowMarkup = rows
    .map(([label, value]) => `<div><dt>${htmlEscape(label)}</dt><dd>${String(value)}</dd></div>`)
    .join('');

  const documentation = documentationSections(requirement.documentation);
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

  return `<article class="requirement-card ${cssKind}" id="requirement-${index}" aria-labelledby="requirement-${index}-title">
  <header class="requirement-card-header">
    <span class="requirement-kind">${kind}</span>
    <div class="requirement-card-title requirement-statement" id="requirement-${index}-title" role="heading" aria-level="3">${inlineHtml(requirement.statement)}</div>
    <span class="requirement-draft-id">${htmlEscape(permanentId)}</span>
  </header>
  ${key ? `<div class="requirement-key-row"><span class="requirement-label">Key</span>${key}</div>` : ''}
  <div class="requirement-badges">${badges}</div>
  ${rowMarkup ? `<dl class="requirement-rows">${rowMarkup}</dl>` : ''}
  ${visible}
  ${proofMarkup}
</article>`;
}

function functionalityMarkup(frontmatter, pageRoutes, base) {
  const requirements = frontmatter.requirements ?? [];
  if (!requirements.length) return '';
  const facts = [];
  if (frontmatter.realises?.length) facts.push(['Capabilities', frontmatter.realises.join(', ')]);
  if (frontmatter.conformance) facts.push(['Conformance', frontmatter.conformance]);
  if (frontmatter.conformance === 'EXTENSION') facts.push(['Type', 'Extension']);
  if (frontmatter.extension) facts.push(['Extension', String(frontmatter.extension)]);
  const factMarkup = facts
    .map(([label, value]) => `<div><dt>${htmlEscape(label)}</dt><dd>${inlineHtml(value)}</dd></div>`)
    .join('');
  const cards = requirements
    .map((requirement, index) => requirementCard(requirement, index + 1, pageRoutes, base))
    .join('\n');
  return `<div class="functionality-summary">
  <p>${inlineHtml(frontmatter.description)}</p>
  ${factMarkup ? `<dl>${factMarkup}</dl>` : ''}
</div>

## Requirements

<p class="requirements-introduction">This functionality defines ${requirements.length} authoring-draft requirement${requirements.length === 1 ? '' : 's'}. “Unnumbered draft” reflects the source metadata and does not invent a permanent requirement identifier.</p>

<div class="requirements-list">
${cards}
</div>
`;
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

function homeMetadataMarkup(metadata, authors) {
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
    ['Extensions', extensionsMetadata(metadata.extensions)],
  ];
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

function generatedFrontmatter({ title, description, pagefind }, unofficial) {
  return `---\n${YAML.stringify({
    title,
    description,
    ...(pagefind === false ? { pagefind: false } : {}),
    head: [{ tag: 'meta', attrs: { name: 'robots', content: robotsContent(unofficial) } }],
  })}---\n\n`;
}

function transformBody({ page, pageRoutes, pageAnchors, base, metadata, authors, unofficial }) {
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
  replacements.push(
    ...referenceReplacements({ tree, source, sourceName, pageRoutes, pageAnchors, base }),
  );
  let body = applyReplacements(source, replacements, sourceName).replace(/^\s+/, '');
  if (page.compatibilityAnchors?.size) {
    body = `${[...page.compatibilityAnchors].map((id) => `<a id="${htmlEscape(id)}"></a>`).join('\n')}\n\n${body}`;
  }
  const functionality = functionalityMarkup(frontmatter, pageRoutes, base);
  if (functionality) body = `${functionality}\n\n${body}`;
  if (sourceName === 'README.md') body = `${homeMetadataMarkup(metadata, authors)}\n\n${body}`;
  const isArchive = sourceName.startsWith('resources/history/') || sourceName.includes('/legacy/');
  if (isArchive) {
    body = `:::caution[Archived source]\nThis page preserves historical material and is not current conformance text.\n:::\n\n${body}`;
  }
  const description =
    typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : sourceName === 'README.md'
        ? metadata.abstract
        : `${title} in the Digital Registries specification.`;
  return `${generatedFrontmatter({ title, description, pagefind: isArchive ? false : undefined }, unofficial)}${body}`;
}

function sidebarFromToc(toc, pagesBySource, ordered) {
  const sidebar = [{ label: 'Home', slug: '' }];
  const tocSources = new Set(['README.md']);
  for (const [section, entries] of Object.entries(toc)) {
    const items = entries.map((entry) => {
      const source = path.posix.join(section, entry);
      tocSources.add(source);
      const page = pagesBySource.get(source);
      return { label: page.title, slug: page.route };
    });
    sidebar.push({ label: section[0].toUpperCase() + section.slice(1), items });
  }
  const extras = ordered.filter((source) => !tocSources.has(source));
  if (extras.length) {
    sidebar.push({
      label: 'Linked documents',
      items: extras.map((source) => ({
        label: pagesBySource.get(source).title,
        slug: pagesBySource.get(source).route,
      })),
    });
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

async function copySupportFiles(sourceRoot, siteRoot, pageSources, snapshots, referencedPaths) {
  const copied = [];
  const publicRoot = path.join(siteRoot, 'public');
  const sourceReal = await realpath(sourceRoot);

  async function walk(source, relative) {
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
        for (const entry of await readdir(resolved)) {
          await walk(path.join(resolved, entry), path.join(relative, entry));
        }
      } else {
        const contents = await readFile(resolved);
        const destination = path.join(publicRoot, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, contents);
        snapshots.set(relative.split(path.sep).join('/'), contents);
        copied.push(relative.split(path.sep).join('/'));
      }
      return;
    }
    if (details.isDirectory()) {
      for (const entry of await readdir(source)) {
        await walk(path.join(source, entry), path.join(relative, entry));
      }
      return;
    }
    if (posixRelative.endsWith('.md') || pageSources.has(posixRelative)) return;
    const contents = await readFile(source);
    const destination = path.join(publicRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    snapshots.set(posixRelative, contents);
    copied.push(posixRelative);
  }

  for (const entry of await readdir(sourceRoot)) {
    await walk(path.join(sourceRoot, entry), entry);
  }
  return copied.toSorted();
}

function redirectHtml(target, unofficial) {
  const encoded = JSON.stringify(target);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="${supportRobots(unofficial)}"><meta http-equiv="refresh" content="0;url=${htmlEscape(target)}"><title>Redirecting…</title></head><body data-pagefind-ignore><p><a href="${htmlEscape(target)}">Continue to the Starlight page</a></p><script>location.replace(${encoded} + location.search + location.hash);</script></body></html>\n`;
}

async function writeRedirects(siteRoot, pages, base, unofficial) {
  const redirects = [];
  for (const page of pages) {
    if (page.sourceName === 'README.md') continue;
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
  unofficial,
) {
  const indexes = [];
  const directories = new Set();
  const sourceReal = await realpath(sourceRoot);
  for (const page of pages) {
    for (const reference of localReferences(page.tree)) {
      if (/^[A-Za-z][A-Za-z+.-]*:/.test(reference) || reference.startsWith('//')) continue;
      const { pathname } = splitReference(reference);
      if (!pathname.endsWith('/')) continue;
      const target = safeRelativeTarget(page.sourceName, pathname).replace(/\/+$/, '');
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
    const sourceDirectory = path.join(sourceRoot, directory);
    const directoryDetails = await lstat(sourceDirectory);
    if (directoryDetails.isSymbolicLink()) {
      const resolved = await realpath(sourceDirectory);
      if (resolved !== sourceReal && !resolved.startsWith(`${sourceReal}${path.sep}`)) {
        throw new Error(`Refusing source symlink outside repository: ${directory}`);
      }
      const resolvedRelative = path.relative(sourceReal, resolved).split(path.sep).join('/');
      if (!isPublishableSupportPath(resolvedRelative)) {
        if (referencedSupportPathIncludes(directory, referencedPaths)) {
          throw new Error(
            `Refusing referenced support symlink ${directory}: target is hidden operational/config path ${resolvedRelative}`,
          );
        }
        continue;
      }
    }
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    const links = [];
    for (const entry of entries) {
      const logical = `${directory}/${entry.name}`;
      if (!isPublishableSupportPath(logical)) continue;
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(path.join(sourceRoot, logical));
        if (resolved !== sourceReal && !resolved.startsWith(`${sourceReal}${path.sep}`)) {
          throw new Error(`Refusing source symlink outside repository: ${logical}`);
        }
        const resolvedRelative = path.relative(sourceReal, resolved).split(path.sep).join('/');
        if (!isPublishableSupportPath(resolvedRelative)) {
          if (referencedSupportPathIncludes(logical, referencedPaths)) {
            throw new Error(
              `Refusing referenced support symlink ${logical}: target is hidden operational/config path ${resolvedRelative}`,
            );
          }
          continue;
        }
        isDirectory = (await stat(resolved)).isDirectory();
      }
      const relative = `${logical}${isDirectory ? '/' : ''}`;
      links.push(
        `<li><a href="${htmlEscape(baseUrl(base, relative))}">${htmlEscape(entry.name)}${isDirectory ? '/' : ''}</a></li>`,
      );
    }
    const output = path.join(siteRoot, 'public', directory, 'index.html');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="${supportRobots(unofficial)}"><title>${htmlEscape(directory)} downloads</title></head><body data-pagefind-ignore><main><h1>${htmlEscape(directory)} downloads</h1><p>Source support files for the local Digital Registries preview.</p><ul>${links.join('')}</ul></main></body></html>\n`,
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
      if (/^[A-Za-z][A-Za-z+.-]*:/.test(reference) || reference.startsWith('//')) continue;
      const { pathname, fragment } = splitReference(reference);
      if (!fragment) continue;
      const targetName = pathname ? safeRelativeTarget(page.sourceName, pathname) : page.sourceName;
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

  const { ordered, pages: pageSources } = await discoverPages(absoluteSourceRoot, toc);
  const warnings = [];
  const loaded = [];
  const snapshots = new Map([
    ['toc.yml', tocBuffer],
    ['metadata.yml', metadataBuffer],
    ['authors.yml', authorsBuffer],
  ]);
  let requirementCount = 0;
  for (const sourceName of ordered) {
    const sourceBuffer = await readFile(path.join(absoluteSourceRoot, sourceName));
    snapshots.set(sourceName, sourceBuffer);
    const normalized = normalizeDuplicateAnchors(sourceBuffer.toString('utf8'), sourceName);
    warnings.push(...normalized.warnings);
    const source = normalized.source;
    const tree = parser.parse(source);
    const { node: frontmatterNode, value: frontmatter } = sourceFrontmatter(tree);
    const headings = headingDetails(tree, sourceName);
    const title = pageLabel(sourceName, frontmatter, headings);
    const route = routeFor(sourceName);
    const anchors = new Set([...headings.map((heading) => heading.id), ...standaloneAnchors(tree)]);
    requirementCount += frontmatter.requirements?.length ?? 0;
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
  const pagesBySource = new Map(loaded.map((page) => [page.sourceName, page]));
  addArchiveCompatibilityAnchors(loaded, warnings);
  const pageRoutes = new Map(loaded.map((page) => [page.sourceName, page.route]));
  const pageAnchors = new Map(loaded.map((page) => [page.sourceName, page.anchors]));
  const referencedSupportPaths = collectReferencedSupportPaths(loaded);
  assertReferencedSupportPathsAllowed(referencedSupportPaths);
  const sidebar = sidebarFromToc(toc, pagesBySource, ordered);

  await pruneFormerGeneratedPages(absoluteSiteRoot, loaded);

  for (const page of loaded) {
    const output = transformBody({
      page,
      pageRoutes,
      pageAnchors,
      base: normalizedBase,
      metadata,
      authors,
      unofficial,
    });
    const relative = page.route ? `${page.route}.md` : 'index.md';
    const destination = path.join(absoluteSiteRoot, 'src/content/docs', relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, output);
  }

  const supportFiles = await copySupportFiles(
    absoluteSourceRoot,
    absoluteSiteRoot,
    pageSources,
    snapshots,
    referencedSupportPaths,
  );
  const supportIndexes = await writeSupportDirectoryIndexes(
    absoluteSourceRoot,
    absoluteSiteRoot,
    loaded,
    pageRoutes,
    normalizedBase,
    referencedSupportPaths,
    unofficial,
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
    supportFiles,
    supportIndexes,
    redirects,
    warnings: [...new Set(warnings)],
    ...sourceState,
    pages: loaded.map((page) => ({
      source: page.sourceName,
      route: page.route,
      title: page.title,
      anchors: [...page.anchors].map((id) => ({ id })),
    })),
  };
  const manifestPath = path.join(absoluteSiteRoot, 'src/data/generated/spec.json');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}


