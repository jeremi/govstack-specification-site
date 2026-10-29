import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import GithubSlugger from 'github-slugger';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import YAML from 'yaml';

import { robotsContent, sourceLinks } from '../scripts/publication.mjs';

const execFileAsync = promisify(execFile);
const SPECIAL_DOWNLOADS = new Map([
  ['rules.yaml', 'rules.yaml'],
  ['linter/coverage.yaml', 'linter/coverage.yaml'],
]);
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);

function textContent(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (!node.children) return '';
  return node.children.map(textContent).join('');
}

function explicitAnchor(value) {
  const anchor = /^<a\s+([^>]+)(?:><\/a>|)>$/i.exec(value.trim());
  if (!anchor) return undefined;
  const attributes = Object.fromEntries(
    [...anchor[1].matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)].map((match) => [
      match[1].toLowerCase(),
      match[3],
    ]),
  );
  if (!attributes.id || attributes.href !== `#${attributes.id}`) return undefined;
  return attributes.id;
}

function headingDetails(tree, sourceName) {
  const slugger = new GithubSlugger();
  const headings = [];
  visit(tree, 'heading', (node) => {
    const explicit = [];
    const explicitIndexes = new Set();
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      if (child.type !== 'html') continue;
      const id = explicitAnchor(child.value);
      if (!id) continue;
      const compound = /<\/a>$/i.test(child.value.trim());
      const closing = node.children[index + 1];
      if (!compound && !(closing?.type === 'html' && closing.value.trim().toLowerCase() === '</a>')) continue;
      explicit.push(id);
      explicitIndexes.add(index);
      if (!compound) explicitIndexes.add(index + 1);
    }
    if (explicit.length > 1) {
      throw new Error(`${sourceName}: a heading has more than one explicit anchor`);
    }
    const text = textContent({
      ...node,
      children: node.children.filter((_, index) => !explicitIndexes.has(index)),
    }).trim();
    if (!text) throw new Error(`${sourceName}: heading text must not be empty`);
    const id = explicit[0] ?? slugger.slug(text);
    headings.push({ node, depth: node.depth, text, id, explicit: explicit[0] });
  });

  const ids = new Set();
  for (const { id } of headings) {
    if (ids.has(id)) throw new Error(`${sourceName}: duplicate heading anchor #${id}`);
    ids.add(id);
  }
  return headings;
}

function routeFor(source) {
  if (source === 'README.md') return '';
  if (source.endsWith('/README.md')) return source.slice(0, -'/README.md'.length);
  return source.slice(0, -'.md'.length);
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

function firstLink(node) {
  if (node.type === 'link') return node;
  for (const child of node.children ?? []) {
    const found = firstLink(child);
    if (found) return found;
  }
  return undefined;
}

function parseSummary(source, sourceRoot) {
  const tree = parser.parse(source);
  const pages = [];
  const sidebar = [];
  let currentGroup;

  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 2) {
      currentGroup = { label: textContent(node).trim(), items: [] };
      if (!currentGroup.label) throw new Error('SUMMARY.md: sidebar group heading must not be empty');
      sidebar.push(currentGroup);
      continue;
    }
    if (node.type !== 'list') continue;

    for (const item of node.children) {
      const link = firstLink(item);
      if (!link) throw new Error('SUMMARY.md: every list item must contain a Markdown link');
      const target = link.url.split('#', 1)[0];
      if (!target.endsWith('.md') || path.posix.isAbsolute(target) || target.includes('..')) {
        throw new Error(`SUMMARY.md: unsupported page target ${link.url}`);
      }
      const normalized = path.posix.normalize(target);
      const page = { source: normalized, route: routeFor(normalized), label: textContent(link).trim() };
      pages.push(page);
      const sidebarItem = { label: page.label, slug: page.route };
      if (currentGroup) currentGroup.items.push(sidebarItem);
      else sidebar.push(sidebarItem);
    }
  }

  if (pages.length === 0) throw new Error('SUMMARY.md does not allowlist any pages');
  const duplicates = pages.filter((page, index) => pages.findIndex((other) => other.source === page.source) !== index);
  if (duplicates.length > 0) throw new Error(`SUMMARY.md contains duplicate page ${duplicates[0].source}`);

  return { pages, sidebar, sourceRoot };
}

function yamlFrontmatter(tree, sourceName) {
  const frontmatter = tree.children.find((node) => node.type === 'yaml');
  if (!frontmatter) throw new Error(`${sourceName}: YAML frontmatter is required`);
  const value = YAML.parse(frontmatter.value);
  if (!value || typeof value.description !== 'string' || value.description.trim() === '') {
    throw new Error(`${sourceName}: frontmatter description is required`);
  }
  return { node: frontmatter, description: value.description.trim() };
}

function offset(position, sourceName) {
  if (position?.offset === undefined) throw new Error(`${sourceName}: parser did not provide source offsets`);
  return position.offset;
}

function hintReplacements(source, sourceName) {
  const replacements = [];
  const lines = source.match(/.*(?:\n|$)/g).filter(Boolean);
  let cursor = 0;
  let fence;
  let active;

  for (const line of lines) {
    const start = cursor;
    cursor += line.length;
    const text = line.replace(/\r?\n$/, '');
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(text);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      continue;
    }
    if (fence) continue;

    if (text.includes('{% hint')) {
      if (active) throw new Error(`${sourceName}: malformed hint, nested hints are not supported`);
      const match = /^\{% hint style=(["'])([^"']+)\1 %\}\s*$/.exec(text);
      if (!match) throw new Error(`${sourceName}: malformed hint opening directive`);
      if (!['info', 'warning'].includes(match[2])) {
        throw new Error(`${sourceName}: unsupported hint style ${match[2]}`);
      }
      const kind = match[2] === 'info' ? 'note' : 'caution';
      replacements.push({ start, end: cursor, value: `:::${kind}\n` });
      active = { style: match[2] };
      continue;
    }

    if (text.includes('{% endhint')) {
      if (text.trim() !== '{% endhint %}' || !active) {
        throw new Error(`${sourceName}: malformed hint closing directive`);
      }
      replacements.push({ start, end: cursor, value: ':::\n' });
      active = undefined;
    }
  }

  if (active) throw new Error(`${sourceName}: malformed hint, missing {% endhint %}`);
  return replacements;
}

function linkDestinationRange(source, node, sourceName) {
  const start = offset(node.position.start, sourceName);
  const end = offset(node.position.end, sourceName);
  const markdown = source.slice(start, end);
  const opener = markdown.lastIndexOf('](');
  if (opener < 0) throw new Error(`${sourceName}: only inline Markdown links are supported for ${node.url}`);
  let relativeStart = opener + 2;
  while (/\s/.test(markdown[relativeStart] ?? '')) relativeStart += 1;
  const angled = markdown[relativeStart] === '<';
  if (angled) relativeStart += 1;
  const relativeEnd = relativeStart + node.url.length;
  const raw = markdown.slice(relativeStart, relativeEnd);
  if (raw !== node.url) {
    throw new Error(`${sourceName}: could not safely locate link destination ${node.url}`);
  }
  if (angled && markdown[relativeEnd] !== '>') {
    throw new Error(`${sourceName}: malformed angle-bracket link destination ${node.url}`);
  }
  return { start: start + relativeStart, end: start + relativeEnd };
}

function rewriteRelativeLink({ url, sourceName, pageRoutes, pageAnchors, base, blobRoot }) {
  if (/^[A-Za-z][A-Za-z+.-]*:/.test(url) || url.startsWith('//') || url.startsWith('/')) return url;
  if (url.startsWith('#')) {
    const fragment = url.slice(1);
    if (fragment && !pageAnchors.get(sourceName).has(decodeURIComponent(fragment))) {
      throw new Error(`${sourceName}: unknown fragment ${url}`);
    }
    return url;
  }

  const hashAt = url.indexOf('#');
  const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
  const withoutFragment = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = withoutFragment.indexOf('?');
  const query = queryAt >= 0 ? withoutFragment.slice(queryAt) : '';
  const pathname = queryAt >= 0 ? withoutFragment.slice(0, queryAt) : withoutFragment;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(sourceName), pathname));

  if (target === 'linter/README.md') return `${blobRoot}/linter/README.md${fragment}`;
  if (SPECIAL_DOWNLOADS.has(target)) return `${baseUrl(base, `downloads/${SPECIAL_DOWNLOADS.get(target)}`)}${fragment}`;
  if (!target.endsWith('.md') || !pageRoutes.has(target)) {
    throw new Error(`${sourceName}: unknown relative link target ${url}`);
  }

  if (fragment) {
    const id = decodeURIComponent(fragment.slice(1));
    if (id && !pageAnchors.get(target).has(id)) {
      throw new Error(`${sourceName}: unknown fragment ${fragment} on ${target}`);
    }
  }
  return `${baseUrl(base, pageRoutes.get(target))}${query}${fragment}`;
}

function linkReplacements({ tree, source, sourceName, pageRoutes, pageAnchors, base, blobRoot }) {
  const replacements = [];
  visit(tree, 'link', (node) => {
    const rewritten = rewriteRelativeLink({
      url: node.url,
      sourceName,
      pageRoutes,
      pageAnchors,
      base,
      blobRoot,
    });
    if (rewritten === node.url) return;
    replacements.push({ ...linkDestinationRange(source, node, sourceName), value: rewritten });
  });
  return replacements;
}

function applyReplacements(source, replacements, sourceName) {
  const ordered = replacements.toSorted((left, right) => right.start - left.start || right.end - left.end);
  let previousStart = source.length + 1;
  let result = source;
  for (const replacement of ordered) {
    if (replacement.end > previousStart) {
      throw new Error(`${sourceName}: generated transformations overlap`);
    }
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return result;
}

function generatedFrontmatter({ title, description, source }, { editRoot, unofficial }) {
  return `---\n${YAML.stringify({
    title,
    description,
    editUrl: `${editRoot}/${source}`,
    head: [{ tag: 'meta', attrs: { name: 'robots', content: robotsContent(unofficial) } }],
  })}---\n\n`;
}

async function gitSourceState(sourceRoot) {
  const { stdout: topLevelOutput } = await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', '--show-toplevel']);
  const topLevel = topLevelOutput.trim();
  const sourcePath = path.relative(topLevel, sourceRoot) || '.';
  const [{ stdout: revisionOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync('git', ['-C', topLevel, 'rev-parse', 'HEAD']),
    execFileAsync('git', [
      '-C',
      topLevel,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      sourcePath,
    ]),
  ]);
  return { sourceRevision: revisionOutput.trim(), sourceDirty: statusOutput.trim() !== '' };
}

async function assertExists(file, message) {
  try {
    await access(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(message);
    throw error;
  }
}

function pageOutputPath(siteRoot, route) {
  if (typeof route !== 'string' || path.posix.isAbsolute(route) || route.split('/').includes('..')) {
    throw new Error(`Unsafe generated page route ${JSON.stringify(route)}`);
  }
  const relativeOutput = route ? `${route}.md` : 'index.md';
  const docsRoot = path.join(siteRoot, 'src/content/docs');
  const output = path.resolve(docsRoot, relativeOutput);
  if (output !== docsRoot && !output.startsWith(`${docsRoot}${path.sep}`)) {
    throw new Error(`Generated page route escapes the content directory: ${route}`);
  }
  return output;
}

async function pruneFormerPages(siteRoot, currentRoutes) {
  const manifestPath = path.join(siteRoot, 'src/data/generated/guide.json');
  let previous;
  try {
    previous = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Could not read previous generated guide manifest: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(previous.pages)) throw new Error('Previous generated guide manifest has no pages array');

  for (const page of previous.pages) {
    if (currentRoutes.has(page.route)) continue;
    const output = pageOutputPath(siteRoot, page.route);
    try {
      await unlink(output);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function sourceDigest(inputs) {
  const hash = createHash('sha256');
  for (const [source, contents] of inputs) {
    const sourceBytes = Buffer.from(source);
    hash.update(`${sourceBytes.length}:`);
    hash.update(sourceBytes);
    hash.update(`${contents.length}:`);
    hash.update(contents);
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function generateSite({ sourceRoot, siteRoot, base = '/', unofficial = false, sourceUrl }) {
  if (!sourceRoot || !siteRoot) throw new Error('generateSite requires sourceRoot and siteRoot');
  const { blobRoot, editRoot } = sourceLinks(sourceUrl);
  const absoluteSourceRoot = await realpath(path.resolve(sourceRoot));
  const absoluteSiteRoot = path.resolve(siteRoot);
  const normalizedBase = normalizeBase(base);
  const summaryPath = path.join(absoluteSourceRoot, 'SUMMARY.md');
  const summaryBuffer = await readFile(summaryPath);
  const summarySource = summaryBuffer.toString('utf8');
  const { pages: summaryPages, sidebar } = parseSummary(summarySource, absoluteSourceRoot);
  const pageRoutes = new Map(summaryPages.map((page) => [page.source, page.route]));
  await pruneFormerPages(absoluteSiteRoot, new Set(pageRoutes.values()));
  const loadedPages = [];
  const inputSnapshots = new Map([['SUMMARY.md', summaryBuffer]]);

  for (const summaryPage of summaryPages) {
    const sourcePath = path.join(absoluteSourceRoot, summaryPage.source);
    await assertExists(sourcePath, `Missing allowlisted page ${summaryPage.source}`);
    const sourceBuffer = await readFile(sourcePath);
    const source = sourceBuffer.toString('utf8');
    inputSnapshots.set(summaryPage.source, sourceBuffer);
    const tree = parser.parse(source);
    const { node: sourceFrontmatter, description } = yamlFrontmatter(tree, summaryPage.source);
    const headings = headingDetails(tree, summaryPage.source);
    const titleHeading = headings.find((heading) => heading.depth === 1);
    if (!titleHeading) throw new Error(`${summaryPage.source}: first-level title heading is required`);
    loadedPages.push({ ...summaryPage, sourceText: source, tree, sourceFrontmatter, description, headings, title: titleHeading.text, titleHeading });
  }

  for (const source of SPECIAL_DOWNLOADS.keys()) {
    const sourcePath = path.join(absoluteSourceRoot, source);
    await assertExists(sourcePath, `Required download ${source} is missing`);
    inputSnapshots.set(source, await readFile(sourcePath));
  }

  const pageAnchors = new Map(
    loadedPages.map((page) => [page.source, new Set(page.headings.map((heading) => heading.id))]),
  );

  for (const page of loadedPages) {
    const h1Start = offset(page.titleHeading.node.position.start, page.source);
    let h1End = offset(page.titleHeading.node.position.end, page.source);
    if (page.sourceText[h1End] === '\r' && page.sourceText[h1End + 1] === '\n') h1End += 2;
    else if (page.sourceText[h1End] === '\n') h1End += 1;
    const retainedAnchor = `<a id="${page.titleHeading.id}"></a>\n\n`;
    const replacements = [
      {
        start: offset(page.sourceFrontmatter.position.start, page.source),
        end: offset(page.sourceFrontmatter.position.end, page.source),
        value: '',
      },
      { start: h1Start, end: h1End, value: retainedAnchor },
      ...hintReplacements(page.sourceText, page.source),
      ...linkReplacements({
        tree: page.tree,
        source: page.sourceText,
        sourceName: page.source,
        pageRoutes,
        pageAnchors,
        base: normalizedBase,
        blobRoot,
      }),
    ];
    const body = applyReplacements(page.sourceText, replacements, page.source);
    const output = `${generatedFrontmatter(page, { editRoot, unofficial })}${body.replace(/^\s+/, '')}`;
    const outputPath = pageOutputPath(absoluteSiteRoot, page.route);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output);
  }

  for (const [source, download] of SPECIAL_DOWNLOADS) {
    const outputPath = path.join(absoluteSiteRoot, 'public/downloads', download);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, inputSnapshots.get(source));
  }

  const rules = YAML.parse(inputSnapshots.get('rules.yaml').toString('utf8'));
  if (!rules || typeof rules.version !== 'string') throw new Error('rules.yaml: string version is required');
  const sourceState = await gitSourceState(absoluteSourceRoot);
  const manifest = {
    sidebar,
    version: rules.version,
    sourceDigest: sourceDigest(inputSnapshots),
    ...sourceState,
    pages: loadedPages.map((page) => ({
      source: page.source,
      route: page.route,
      title: page.title,
      anchors: page.headings.map(({ depth, text, id }) => ({ depth, text, id })),
    })),
  };
  const manifestPath = path.join(absoluteSiteRoot, 'src/data/generated/guide.json');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}


