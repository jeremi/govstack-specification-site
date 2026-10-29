import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { parse } from 'parse5';
import { assertSafeOutputTree } from './output.mjs';

const searchFiles = [
  'pagefind/pagefind.js',
  'pagefind/pagefind-ui.js',
  'pagefind/pagefind-ui.css',
];

function elements(node, result = []) {
  if (node.tagName) result.push(node);
  for (const child of node.childNodes ?? []) elements(child, result);
  return result;
}

function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function normalizeBase(base) {
  const parts = String(base).split('/').filter(Boolean);
  return parts.length === 0 ? '/' : `/${parts.join('/')}/`;
}

function relativeOutput(value, label) {
  if (typeof value !== 'string' || value.includes('\\')) {
    throw new Error(`${String(value)}: invalid ${label} path`);
  }
  const relative = path.posix.normalize(value.replace(/^\.\//, ''));
  if (
    !relative ||
    relative === '.' ||
    relative.startsWith('/') ||
    relative === '..' ||
    relative.startsWith('../')
  ) {
    throw new Error(`${value}: invalid ${label} path`);
  }
  return relative;
}

function inside(root, relative, label) {
  const absoluteRoot = path.resolve(root);
  const file = path.resolve(absoluteRoot, relative);
  if (!file.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`${relative}: ${label} escapes its root`);
  }
  return file;
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function fetchLocal(url) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
}

function hasRobots(nodes, directive) {
  return nodes.some(
    (node) =>
      node.tagName === 'meta' &&
      attribute(node, 'name')?.toLowerCase() === 'robots' &&
      attribute(node, 'content')
        ?.toLowerCase()
        .split(/[\s,]+/)
        .includes(directive),
  );
}

function hasDraftMarker(nodes, html) {
  if (html.includes('Local authoring preview')) return true;
  return hasRobots(nodes, 'noindex');
}

function countRequirementCards(nodes) {
  return nodes.filter((node) =>
    attribute(node, 'class')?.split(/\s+/).includes('requirement-card'),
  ).length;
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function canonicalDownload({ download, manifest, siteRoot, workspace }) {
  const source = relativeOutput(download.source, 'download source');
  if (manifest.sourceRoot)
    return readFile(inside(manifest.sourceRoot, source, 'download source'));

  const output = relativeOutput(download.output, 'download output');
  const candidates = [
    inside(workspace, path.posix.join('public', output), 'staged download'),
    inside(siteRoot, path.posix.join('public', output), 'staged download'),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return readFile(candidate);
  }
  throw new Error(
    `${download.source}: canonical download source is unavailable`,
  );
}

/** Start the shared Astro preview and verify its complete HTTP publication surface. */
export async function checkServed({
  siteRoot,
  distDir,
  manifest,
  base = '/',
  workspace,
}) {
  if (!siteRoot || !distDir || !manifest || !workspace) {
    throw new Error(
      'checkServed requires siteRoot, distDir, manifest, and workspace',
    );
  }
  await assertSafeOutputTree(distDir);
  const normalizedBase = normalizeBase(base);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const astro = path.join(siteRoot, 'node_modules/astro/bin/astro.mjs');
  const config = 'astro.config.mjs';
  const server = spawn(
    process.execPath,
    [
      astro,
      'preview',
      '--ignore-lock',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--config',
      config,
    ],
    {
      cwd: siteRoot,
      env: {
        ...process.env,
        GOVSTACK_SITE_WORKSPACE: path.resolve(workspace),
        DOCS_DIST_DIR: path.resolve(distDir),
        DOCS_BASE: normalizedBase,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let spawnError;
  server.stdout.on('data', (chunk) => {
    output += chunk;
  });
  server.stderr.on('data', (chunk) => {
    output += chunk;
  });
  server.once('error', (error) => {
    spawnError = error;
  });
  const stopped = new Promise((resolve) => server.once('close', resolve));

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnError)
        throw new Error(`Preview failed to start: ${spawnError.message}`);
      if (server.exitCode !== null)
        throw new Error(`Preview exited before checks:\n${output}`);
      try {
        ready = (await fetchLocal(`${origin}${normalizedBase}`)).ok;
      } catch (error) {
        if (!(error instanceof TypeError) && error.name !== 'TimeoutError')
          throw error;
      }
      if (ready) break;
      await setTimeout(100);
    }
    if (!ready) throw new Error(`Preview did not become ready:\n${output}`);

    const errors = [];
    let requirements = 0;
    for (const page of manifest.pages ?? []) {
      const route = String(page.route ?? '')
        .split('/')
        .filter(Boolean)
        .join('/');
      const url = `${origin}${normalizedBase}${route ? `${route}/` : ''}`;
      const response = await fetchLocal(url);
      if (response.status !== 200) {
        errors.push(`${page.source}: served page returned ${response.status}`);
        continue;
      }
      const html = await response.text();
      const nodes = elements(parse(html));
      if (!hasDraftMarker(nodes, html)) {
        errors.push(
          `${page.source}: served page lacks Local authoring preview or noindex metadata`,
        );
      }
      if (manifest.unofficial) {
        if (!nodes.some((node) => attribute(node, 'data-unofficial-banner') !== undefined))
          errors.push(`${page.source}: served page lacks the unofficial banner`);
        if (!hasRobots(nodes, 'nofollow'))
          errors.push(`${page.source}: served page lacks nofollow metadata`);
      }
      requirements += countRequirementCards(nodes);
    }

    if (manifest.unofficial) {
      const response = await fetchLocal(`${origin}${normalizedBase}robots.txt`);
      if (response.status !== 200)
        errors.push(`robots.txt: unofficial crawler policy returned ${response.status}`);
    }

    for (const searchFile of searchFiles) {
      const response = await fetchLocal(
        `${origin}${normalizedBase}${searchFile}`,
      );
      if (response.status !== 200)
        errors.push(`${searchFile}: search file returned ${response.status}`);
    }

    const missing = await fetchLocal(
      `${origin}${normalizedBase}does-not-exist-for-site-check/`,
    );
    const missingHtml = await missing.text();
    if (missing.status !== 404)
      errors.push(`Missing route returned ${missing.status} instead of 404`);
    if (!hasDraftMarker(elements(parse(missingHtml)), missingHtml)) {
      errors.push('404 page lacks Local authoring preview or noindex metadata');
    }

    for (const download of manifest.downloads ?? []) {
      let outputPath;
      try {
        outputPath = relativeOutput(download.output, 'download output');
        const response = await fetchLocal(
          `${origin}${normalizedBase}${outputPath}`,
        );
        if (response.status !== 200) {
          errors.push(
            `${outputPath}: served download returned ${response.status}`,
          );
          continue;
        }
        const served = Buffer.from(await response.arrayBuffer());
        const canonical = await canonicalDownload({
          download,
          manifest,
          siteRoot,
          workspace,
        });
        if (digest(served) !== digest(canonical)) {
          errors.push(
            `${outputPath}: served download differs from source ${download.source}`,
          );
        }
      } catch (error) {
        errors.push(`${outputPath ?? download.output}: ${error.message}`);
      }
    }

    if (
      manifest.requirementCount !== undefined &&
      requirements !== manifest.requirementCount
    ) {
      errors.push(
        `Found ${requirements} served requirement cards, expected ${manifest.requirementCount} from the source manifest`,
      );
    }
    if (/\b(?:error|warn)\b/i.test(output)) {
      errors.push(`Preview emitted warnings or errors:\n${output}`);
    }
    if (errors.length > 0) throw new Error(errors.join('\n'));
    return {
      pages: (manifest.pages ?? []).length,
      searchFiles: searchFiles.length,
      downloads: (manifest.downloads ?? []).length,
      requirements,
    };
  } finally {
    if (server.exitCode === null && !server.killed) server.kill('SIGTERM');
    await stopped;
  }
}
