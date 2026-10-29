import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkBuilt } from '../scripts/check-built.mjs';
import { checkServed } from '../scripts/check-served.mjs';

const draftHead =
  '<!doctype html><html lang="en"><head><meta name="robots" content="noindex, follow"></head><body>';

async function write(root, relative, contents) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function builtFixture(t, { base = '/' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'govstack-site-check-'));
  t.after(() => rm(root, { recursive: true }));
  const distDir = path.join(root, 'dist');
  await write(
    distDir,
    'index.html',
    `${draftHead}<h1>Specification</h1><a href="${base}chapter/#stable">Chapter</a><img src="${base}assets/diagram.svg" alt="Diagram"></body></html>`,
  );
  await write(
    distDir,
    'chapter/index.html',
    `${draftHead}<h1>Chapter</h1><div class="sl-markdown-content"><div class="sl-heading-wrapper level-h2"><h2 id="stable">Stable</h2><a class="sl-anchor-link" href="#stable">Section titled Stable</a></div><a href="${base}resources/">Resources</a></div></body></html>`,
  );
  await write(
    distDir,
    'resources/index.html',
    `${draftHead}<h1>Resources</h1><a href="${base}resources/api.yml">API</a></body></html>`,
  );
  await write(
    distDir,
    'legacy/chapter.html',
    `${draftHead}<h1>Redirect</h1></body></html>`,
  );
  await write(
    distDir,
    'support/about.html',
    `${draftHead}<h1>About</h1></body></html>`,
  );
  await write(
    distDir,
    'assets/diagram.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
  await write(distDir, 'resources/api.yml', 'openapi: 3.1.0\n');
  await write(
    distDir,
    '404.html',
    `${draftHead}<h1>Not found</h1></body></html>`,
  );
  await write(distDir, 'pagefind/pagefind.js', '// search');
  return {
    distDir,
    base,
    manifest: {
      pages: [
        { source: 'README.md', route: '', anchors: [] },
        {
          source: 'chapter.md',
          route: 'chapter',
          anchors: [{ id: 'stable' }],
          searchable: false,
        },
      ],
      supportFiles: [
        'assets/diagram.svg',
        'resources/api.yml',
        'support/about.html',
      ],
      supportIndexes: ['resources/index.html'],
      redirects: [{ legacy: 'legacy/chapter.html', target: `${base}chapter/` }],
    },
  };
}

test('checks declared pages, anchors, support output, base paths, and Pagefind', async (t) => {
  const result = await checkBuilt(
    await builtFixture(t, { base: '/standards/example/' }),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.pages, 2);
  assert.equal(result.links, 4);
});

test('rejects hidden operational files even when the support manifest declares them', async (t) => {
  const options = await builtFixture(t);
  await write(options.distDir, 'examples/.env', 'INERT_FIXTURE=example');
  options.manifest.supportFiles.push('examples/.env');
  const result = await checkBuilt(options);
  assert.match(result.errors.join('\n'), /operational/);
});

test('rejects visible output symlinks without reading their targets', async (t) => {
  const options = await builtFixture(t);
  const target = path.join(options.distDir, '..', '.env');
  await writeFile(target, 'INERT_FIXTURE=example');
  await symlink(target, path.join(options.distDir, 'assets/public.txt'));
  options.manifest.supportFiles.push('assets/public.txt');
  const result = await checkBuilt(options);
  assert.match(result.errors.join('\n'), /symlink/);
  await assert.rejects(checkServed({
    siteRoot: path.dirname(options.distDir),
    workspace: path.dirname(options.distDir),
    ...options,
  }), /symlink/);
});

test('reports page structure, accessibility, metadata, anchors, links, and assets', async (t) => {
  const options = await builtFixture(t);
  await write(
    options.distDir,
    'chapter/index.html',
    '<html><head></head><body><h1 id="same">One</h1><h1 id="same">Two</h1><img src="/missing.png"><a href="/#absent">Missing fragment</a></body></html>',
  );
  const result = await checkBuilt(options);
  const errors = result.errors.join('\n');
  assert.match(errors, /duplicate HTML ids/);
  assert.match(errors, /missing source anchor #stable/);
  assert.match(errors, /expected one page title/);
  assert.match(errors, /missing draft noindex metadata/);
  assert.match(errors, /missing document language/);
  assert.match(errors, /image lacks alt text/);
  assert.match(errors, /missing local target \/missing\.png/);
  assert.match(errors, /broken fragment \/#absent/);
});

test('allows only manifest-declared HTML output and requires declared support files', async (t) => {
  const options = await builtFixture(t);
  await write(
    options.distDir,
    'orphan/index.html',
    `${draftHead}<h1>Orphan</h1></body></html>`,
  );
  await rm(path.join(options.distDir, 'resources/api.yml'));
  const errors = (await checkBuilt(options)).errors.join('\n');
  assert.match(
    errors,
    /orphan\/index\.html: page outside the source navigation manifest/,
  );
  assert.match(errors, /resources\/api\.yml: missing declared support file/);
  assert.doesNotMatch(errors, /support\/about\.html: page outside/);
  assert.doesNotMatch(errors, /legacy\/chapter\.html: page outside/);
  assert.doesNotMatch(errors, /resources\/index\.html: page outside/);
});

test('rejects links that escape a configured base path', async (t) => {
  const options = await builtFixture(t, { base: '/standards/example/' });
  await write(
    options.distDir,
    'index.html',
    `${draftHead}<h1>Specification</h1><a href="/chapter/">Wrong base</a></body></html>`,
  );
  assert.match(
    (await checkBuilt(options)).errors.join('\n'),
    /link escapes base: \/chapter\//,
  );
});

test('keeps pages marked non-searchable out of the default Pagefind body index', async (t) => {
  const options = await builtFixture(t);
  await write(
    options.distDir,
    'chapter/index.html',
    `${draftHead}<main data-pagefind-body><h1>Chapter</h1><h2 id="stable">Stable</h2></main></body></html>`,
  );
  assert.match(
    (await checkBuilt(options)).errors.join('\n'),
    /chapter\.md: non-searchable page is exposed to the default Pagefind body index/,
  );
});

test('requires native Starlight wrappers and matching anchor links for rendered content headings', async (t) => {
  const options = await builtFixture(t);
  await write(
    options.distDir,
    'chapter/index.html',
    `${draftHead}<h1>Chapter</h1><div class="sl-markdown-content"><h2 id="stable">Stable</h2><div class="sl-heading-wrapper level-h3"><h3 id="details">Details</h3><a class="sl-anchor-link" href="#wrong">Wrong anchor</a></div></div></body></html>`,
  );
  const errors = (await checkBuilt(options)).errors.join('\n');
  assert.match(
    errors,
    /chapter\.md: heading #stable lacks a native Starlight heading wrapper/,
  );
  assert.match(
    errors,
    /chapter\.md: heading #details lacks a matching Starlight anchor link/,
  );
});

test('rejects unrendered Starlight aside directives outside code examples', async (t) => {
  const options = await builtFixture(t);
  await write(
    options.distDir,
    'chapter/index.html',
    `${draftHead}<h1>Chapter</h1><div class="sl-markdown-content"><p>:::caution[Archived source]\nStill raw.</p><pre><code>:::note\nIntentional example.</code></pre></div></body></html>`,
  );
  assert.match(
    (await checkBuilt(options)).errors.join('\n'),
    /chapter\.md: contains an unrendered Starlight aside directive/,
  );
});

async function servedFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'govstack-served-check-'));
  t.after(() => rm(root, { recursive: true }));
  const siteRoot = path.join(root, 'site');
  const workspace = path.join(root, 'workspace');
  const sourceRoot = path.join(root, 'source');
  const distDir = path.join(root, 'dist');
  const base = '/standards/example/';
  await write(siteRoot, 'astro.config.mjs', 'export default {};\n');
  await write(
    siteRoot,
    'node_modules/astro/bin/astro.mjs',
    `import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] !== 'preview' || !args.includes('--ignore-lock') || !args.includes('--config')) process.exit(7);
if (!process.env.GOVSTACK_SITE_WORKSPACE || !process.env.DOCS_DIST_DIR || !process.env.DOCS_BASE) process.exit(8);
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
const base = process.env.DOCS_BASE;
const dist = process.env.DOCS_DIST_DIR;
createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://local.invalid').pathname;
  let relative = pathname.startsWith(base) ? pathname.slice(base.length) : '__outside__';
  if (!relative || relative.endsWith('/')) relative += 'index.html';
  try {
    const contents = await readFile(path.join(dist, relative));
    response.statusCode = 200;
    response.end(contents);
  } catch {
    response.statusCode = 404;
    response.end(await readFile(path.join(dist, '404.html')));
  }
}).listen(port, host);
`,
  );
  await write(
    distDir,
    'index.html',
    `${draftHead}<h1>Specification</h1><footer>Local authoring preview</footer></body></html>`,
  );
  await write(
    distDir,
    'requirements/index.html',
    `${draftHead}<h1>Requirements</h1><article class="requirement-card"></article><article class="requirement-card option"></article></body></html>`,
  );
  await write(
    distDir,
    '404.html',
    `${draftHead}<h1>Not found</h1></body></html>`,
  );
  await write(distDir, 'pagefind/pagefind.js', '// search');
  await write(distDir, 'pagefind/pagefind-ui.js', '// search UI');
  await write(distDir, 'pagefind/pagefind-ui.css', '/* search UI */');
  await write(sourceRoot, 'api/openapi.yml', 'openapi: 3.1.0\n');
  await write(distDir, 'downloads/openapi.yml', 'openapi: 3.1.0\n');
  const manifest = {
    sourceRoot,
    requirementCount: 2,
    pages: [
      { source: 'README.md', route: '', anchors: [] },
      { source: 'requirements.md', route: 'requirements', anchors: [] },
    ],
    downloads: [{ source: 'api/openapi.yml', output: 'downloads/openapi.yml' }],
  };
  return { siteRoot, workspace, sourceRoot, distDir, base, manifest };
}

test('serves every page, search files, exact downloads, requirement cards, and draft 404', async (t) => {
  const options = await servedFixture(t);
  const summary = await checkServed(options);
  assert.deepEqual(summary, {
    pages: 2,
    searchFiles: 3,
    downloads: 1,
    requirements: 2,
  });
});

test('rejects changed downloads and incorrect requirement-card totals', async (t) => {
  const options = await servedFixture(t);
  await write(options.distDir, 'downloads/openapi.yml', 'changed\n');
  options.manifest.requirementCount = 3;
  await assert.rejects(
    checkServed(options),
    /served download differs from source.*requirement cards/s,
  );
});

test('falls back to staged public downloads when sourceRoot is absent', async (t) => {
  const options = await servedFixture(t);
  delete options.manifest.sourceRoot;
  await write(
    options.workspace,
    'public/downloads/openapi.yml',
    await readFile(path.join(options.sourceRoot, 'api/openapi.yml')),
  );
  const summary = await checkServed(options);
  assert.equal(summary.downloads, 1);
});
