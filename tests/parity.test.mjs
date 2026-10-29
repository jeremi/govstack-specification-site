import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access,
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { generateSite as generateApiGuide } from '../adapters/api-guide.mjs';
import { generateSite as generateFramework } from '../adapters/framework.mjs';
import { isPublishableSupportPath } from '../scripts/support-paths.mjs';

const excludedSourceParts = new Set([
  '.git',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'node_modules',
]);

const integrations = [
  {
    name: 'API design guide',
    sourceVar: 'GOVSTACK_API_GUIDE_SOURCE_ROOT',
    rendererVar: 'GOVSTACK_API_GUIDE_RENDERER_ROOT',
    originalScript: 'scripts/generate.mjs',
    referenceDependency: 'node_modules/unified/package.json',
    generateShared: generateApiGuide,
    base: '/standards/api/',
    snapshotInputs: snapshotApiGuideInputs,
    downloadPaths(manifest) {
      return [
        ...(manifest.downloads ?? []),
        'downloads/linter/coverage.yaml',
        'downloads/rules.yaml',
      ];
    },
  },
  {
    name: 'specification framework',
    sourceVar: 'GOVSTACK_FRAMEWORK_SOURCE_ROOT',
    rendererVar: 'GOVSTACK_FRAMEWORK_RENDERER_ROOT',
    originalScript: 'scripts/generate.mjs',
    referenceDependency: 'node_modules/unified/package.json',
    generateShared: generateFramework,
    base: '/standards/registries/',
    snapshotInputs: snapshotSourceTree,
    downloadPaths(manifest) {
      return [
        ...(manifest.downloads ?? []),
        ...(manifest.supportFiles ?? []),
        ...(manifest.supportIndexes ?? []),
      ];
    },
  },
];

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function snapshotApiGuideInputs(sourceRoot) {
  const summary = await readFile(path.join(sourceRoot, 'SUMMARY.md'));
  const pageSources = [
    ...summary
      .toString('utf8')
      .matchAll(/^\s*\*\s+\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]*)?\)\s*$/gm),
  ].map((match) => match[1]);
  const inputs = ['SUMMARY.md', ...pageSources, 'rules.yaml', 'linter/coverage.yaml'];
  return new Map(
    await Promise.all(
      inputs.map(async (relative) => [relative, await readFile(path.join(sourceRoot, relative))]),
    ),
  );
}

async function snapshotSourceTree(sourceRoot) {
  const absoluteRoot = await realpath(sourceRoot);
  const snapshots = new Map();

  async function visitDirectory(physicalDirectory, logicalDirectory = '') {
    const entries = await readdir(physicalDirectory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (excludedSourceParts.has(entry.name)) continue;
      const physical = path.join(physicalDirectory, entry.name);
      const logical = path.posix.join(logicalDirectory, entry.name);
      if (!isPublishableSupportPath(logical)) continue;
      const details = await lstat(physical);

      if (details.isSymbolicLink()) {
        snapshots.set(`@symlink/${logical}`, Buffer.from(await readlink(physical)));
        const resolved = await realpath(physical);
        if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
          throw new Error(`${logical}: source symlink escapes ${absoluteRoot}`);
        }
        const resolvedDetails = await stat(resolved);
        if (resolvedDetails.isDirectory()) await visitDirectory(resolved, logical);
        else if (resolvedDetails.isFile()) snapshots.set(logical, await readFile(resolved));
        continue;
      }

      if (details.isDirectory()) await visitDirectory(physical, logical);
      else if (details.isFile()) snapshots.set(logical, await readFile(physical));
    }
  }

  await visitDirectory(absoluteRoot);
  return snapshots;
}

async function safeReferenceSource(sourceRoot, destination) {
  const source = await realpath(sourceRoot);
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (file) => {
      const relative = path.relative(source, file).split(path.sep).join('/');
      if (!relative) return true;
      if (!isPublishableSupportPath(relative)) return false;
      const resolved = await realpath(file);
      const target = path.relative(source, resolved).split(path.sep).join('/');
      return isPublishableSupportPath(target);
    },
  });
  execFileSync('git', ['init', '-q', destination]);
  execFileSync('git', ['-C', destination, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'test: prepare safe renderer reference']);
  return destination;
}

function assertSnapshotsEqual(actual, expected, message) {
  assert.deepEqual([...actual.keys()], [...expected.keys()], `${message}: input path set changed`);
  for (const [relative, expectedBytes] of expected) {
    assert.equal(
      actual.get(relative).compare(expectedBytes),
      0,
      `${message}: ${relative} changed`,
    );
  }
}

function routes(manifest) {
  return manifest.pages.map(({ source, route }) => ({ source, route }));
}

function anchorIDs(manifest) {
  return manifest.pages.map(({ source, route, anchors = [] }) => ({
    source,
    route,
    ids: anchors.map(({ id }) => id),
  }));
}

function navigation(manifest) {
  return manifest.nav ?? manifest.sidebar;
}

function normalizedDownloadPaths(integration, manifest) {
  return [...new Set(integration.downloadPaths(manifest))].toSorted();
}

async function snapshotDownloads(siteRoot, paths) {
  return new Map(
    await Promise.all(
      paths.map(async (relative) => [relative, await readFile(path.join(siteRoot, 'public', relative))]),
    ),
  );
}

for (const definition of integrations) {
  test(`${definition.name} shared adapter preserves original output for publishable inputs without changing sources`, async (t) => {
    for (const variable of [definition.sourceVar, definition.rendererVar]) {
      if (!process.env[variable]) return t.skip(`${variable} is not set`);
    }
    const integration = {
      ...definition,
      sourceRoot: process.env[definition.sourceVar],
      originalModule: process.env[definition.rendererVar],
    };
    if (!(await pathExists(integration.sourceRoot))) {
      t.skip(`canonical source root is unavailable: ${integration.sourceRoot}`);
      return;
    }

    const originalScript = path.join(integration.originalModule, integration.originalScript);
    const referenceDependency = path.join(
      integration.originalModule,
      integration.referenceDependency,
    );
    if (!(await pathExists(referenceDependency))) {
      t.skip(`original generator reference dependency is unavailable: ${referenceDependency}`);
      return;
    }
    const { generateSite: generateOriginal } = await import(pathToFileURL(originalScript).href);
    assert.equal(typeof generateOriginal, 'function', `${originalScript} must export generateSite`);

    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'govstack-site-parity-'));
    t.after(() => rm(scratchRoot, { recursive: true, force: true }));
    const originalSiteRoot = path.join(scratchRoot, 'original');
    const sharedSiteRoot = path.join(scratchRoot, 'shared');
    const before = await integration.snapshotInputs(integration.sourceRoot);
    // The frozen renderer copies operational files. Compare it against a filtered
    // scratch source so the reference run never reads or copies those files.
    const referenceSource = integration.name === 'specification framework'
      ? await safeReferenceSource(integration.sourceRoot, path.join(scratchRoot, 'reference-source'))
      : integration.sourceRoot;

    const [original, shared] = await Promise.all([
      generateOriginal({
        sourceRoot: referenceSource,
        siteRoot: originalSiteRoot,
        base: integration.base,
      }),
      integration.generateShared({
        sourceRoot: integration.sourceRoot,
        siteRoot: sharedSiteRoot,
        base: integration.base,
      }),
    ]);

    const after = await integration.snapshotInputs(integration.sourceRoot);
    assertSnapshotsEqual(after, before, `${integration.name} generation`);

    assert.equal(shared.sourceDigest, original.sourceDigest, 'source digest');
    assert.deepEqual(routes(shared), routes(original), 'page routes');
    assert.deepEqual(anchorIDs(shared), anchorIDs(original), 'page anchor IDs');
    assert.deepEqual(shared.pages, original.pages, 'page manifest entries');
    assert.deepEqual(navigation(shared), navigation(original), 'navigation');
    assert.equal(shared.requirementCount, original.requirementCount, 'requirement count');

    const originalDownloadPaths = normalizedDownloadPaths(integration, original);
    const sharedDownloadPaths = normalizedDownloadPaths(integration, shared);
    assert.deepEqual(sharedDownloadPaths, originalDownloadPaths, 'download path declarations');
    const [originalDownloads, sharedDownloads] = await Promise.all([
      snapshotDownloads(originalSiteRoot, originalDownloadPaths),
      snapshotDownloads(sharedSiteRoot, sharedDownloadPaths),
    ]);
    assertSnapshotsEqual(sharedDownloads, originalDownloads, `${integration.name} downloads`);
  });
}
