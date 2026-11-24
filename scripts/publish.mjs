// Builds every Building Block in publish/building-blocks.yml into one static site:
//
//   <output>/index.html          landing page listing the Building Blocks
//   <output>/bb/<id>/            one specification site per Building Block
//
// Each specification is built and checked by scripts/site.mjs with the base
// <base>bb/<id>/, so its pages and assets resolve only inside its own folder.
// The same command runs locally and in .github/workflows/pages.yml.

import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import YAML from 'yaml';

const execFileAsync = promisify(execFile);
const rendererRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LIST = path.join(rendererRoot, 'publish/building-blocks.yml');
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9._/-]+$/;

export function parseList(text, name = 'building-blocks.yml') {
  const entries = YAML.parse(text)?.building_blocks;
  if (!Array.isArray(entries) || !entries.length) throw new Error(`${name}: building_blocks must be a non-empty list`);
  const seen = new Set();
  return entries.map((entry, index) => {
    const where = `${name}: building_blocks[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} must be a mapping`);
    const { id, title, repository, ref, description = '' } = entry;
    if (typeof id !== 'string' || !ID.test(id)) throw new Error(`${where}: id must be lowercase kebab-case`);
    if (seen.has(id)) throw new Error(`${where}: id ${id} is listed twice`);
    seen.add(id);
    if (typeof title !== 'string' || !title.trim()) throw new Error(`${where}: title is required`);
    if (typeof repository !== 'string' || !REPOSITORY.test(repository)) throw new Error(`${where}: repository must be owner/name`);
    if (typeof ref !== 'string' || !REF.test(ref) || ref.startsWith('-') || ref.includes('..')) {
      throw new Error(`${where}: ref must be a branch, tag or commit`);
    }
    if (typeof description !== 'string') throw new Error(`${where}: description must be text`);
    return { id, title: title.trim(), repository, ref, description: description.trim() };
  });
}

function normalizeBase(base) {
  if (typeof base !== 'string' || !base.startsWith('/')) throw new Error(`--base must start with /, received ${JSON.stringify(base)}`);
  return `${base.replace(/\/+$/, '')}/`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} ${args[0] ?? ''} exited with ${signal || code}`));
    });
  });
}

// Fetches one commit of the source without credentials, hooks or history.
async function checkout(entry, checkouts) {
  const directory = path.join(checkouts, entry.id);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const git = (...args) => execFileAsync('git', ['-C', directory, ...args]);
  await git('init', '-q');
  await git('remote', 'add', 'origin', `https://github.com/${entry.repository}.git`);
  await git('-c', 'protocol.version=2', 'fetch', '-q', '--depth', '1', '--no-tags', 'origin', entry.ref);
  await git('-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD');
  return directory;
}

async function localSource(entry, sources) {
  const directory = path.join(sources, entry.repository.split('/')[1]);
  try {
    if ((await stat(directory)).isDirectory()) return directory;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw new Error(`${entry.id}: no local checkout at ${directory}`);
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function landingHtml(entries, { base, unofficial }) {
  const items = entries
    .map((entry) => {
      const source = `https://github.com/${entry.repository}/tree/${entry.commit ?? entry.ref}`;
      const built = entry.commit ? `${entry.ref} @ ${entry.commit.slice(0, 7)}` : entry.ref;
      return `<li>
  <a class="title" href="${htmlEscape(`${base}bb/${entry.id}/`)}">${htmlEscape(entry.title)}</a>
  ${entry.description ? `<p>${htmlEscape(entry.description)}</p>` : ''}
  <p class="source">Built from <a href="${htmlEscape(source)}">${htmlEscape(entry.repository)}</a> <code>${htmlEscape(built)}</code></p>
</li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${unofficial ? 'noindex, nofollow' : 'noindex, follow'}">
<title>GovStack specifications</title>
<link rel="icon" href="${htmlEscape(`${base}favicon.svg`)}" type="image/svg+xml">
<style>
  :root { --navy: #0a0050; --blue: #0539e3; --gray: #e9e9e9; --text: #1c1d20; --muted: #5b5e66; --bg: #ffffff; --surface: #f6f6f7; --warn: #fff6d1; --warn-border: #fec800; }
  @media (prefers-color-scheme: dark) { :root { --navy: #c9c4ff; --blue: #9bb7ff; --gray: #33343a; --text: #e8e8ea; --muted: #a4a6ad; --bg: #16171a; --surface: #1f2024; --warn: #3a3000; --warn-border: #fec800; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
  h1 { margin: 0 0 0.5rem; color: var(--navy); font-size: 2.25rem; line-height: 1.2; }
  .lead { margin: 0 0 2rem; color: var(--muted); }
  .banner { margin: 0 0 2rem; padding: 0.75rem 1rem; border: 1px solid var(--warn-border); border-radius: 0.45rem; background: var(--warn); font-size: 0.875rem; }
  ul { display: grid; gap: 1rem; margin: 0; padding: 0; list-style: none; }
  li { padding: 1rem 1.1rem; border: 1px solid var(--gray); border-inline-start: 3px solid var(--blue); border-radius: 0.45rem; background: var(--surface); }
  li p { margin: 0.3rem 0 0; }
  a { color: var(--blue); text-underline-offset: 0.16em; }
  .title { font-size: 1.25rem; font-weight: 650; }
  .source { color: var(--muted); font-size: 0.8125rem; overflow-wrap: anywhere; }
  code { font: 0.8125rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
</head>
<body>
<main>
${unofficial ? '<p class="banner"><strong>Unofficial preview.</strong> These pages are built outside the GovStack publication process. The official specifications are at <a href="https://specs.govstack.global/">specs.govstack.global</a>.</p>' : ''}
<h1>GovStack specifications</h1>
<p class="lead">Building Block specifications rendered from their source repositories.</p>
<ul>
${items}
</ul>
</main>
</body>
</html>
`;
}

export async function publish({ list = DEFAULT_LIST, output, base = '/', unofficial = false, sources, checkouts }) {
  if (!output) throw new Error('--output is required');
  const siteBase = normalizeBase(base);
  const entries = parseList(await readFile(list, 'utf8'), path.relative(rendererRoot, list) || list);
  const outputRoot = path.resolve(output);
  await mkdir(outputRoot, { recursive: true });
  const checkoutRoot = sources ? undefined : path.resolve(checkouts ?? path.join(rendererRoot, '.generated/publish-sources'));
  const site = path.join(rendererRoot, 'scripts/site.mjs');
  for (const entry of entries) {
    console.log(`\n== ${entry.title}: ${entry.repository} @ ${entry.ref}`);
    const source = sources ? await localSource(entry, path.resolve(sources)) : await checkout(entry, checkoutRoot);
    entry.commit = (await execFileAsync('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    const options = [
      '--profile', 'framework',
      '--source', await realpath(source),
      '--base', `${siteBase}bb/${entry.id}/`,
      '--output', path.join(outputRoot, 'bb', entry.id),
      ...(unofficial ? ['--unofficial'] : []),
    ];
    await run(process.execPath, [site, 'build', ...options], { cwd: rendererRoot });
    await run(process.execPath, [site, 'test-served', ...options], { cwd: rendererRoot });
  }
  await writeFile(path.join(outputRoot, 'index.html'), landingHtml(entries, { base: siteBase, unofficial }));
  await copyFile(path.join(rendererRoot, 'public/favicon.svg'), path.join(outputRoot, 'favicon.svg'));
  if (unofficial) await writeFile(path.join(outputRoot, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  console.log(`\nPublished ${entries.length} Building Blocks to ${outputRoot}`);
  return entries;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      list: { type: 'string' },
      output: { type: 'string' },
      base: { type: 'string' },
      unofficial: { type: 'boolean' },
      sources: { type: 'string' },
      checkouts: { type: 'string' },
    },
  });
  await publish({
    list: values.list ? path.resolve(values.list) : DEFAULT_LIST,
    output: values.output,
    base: values.base ?? '/',
    unofficial: values.unofficial ?? false,
    sources: values.sources,
    checkouts: values.checkouts,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
