import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { generateSite } from '../adapters/api-guide.mjs';
import remarkGuideAnchors from '../scripts/remark-guide-anchors.mjs';

const execFileAsync = promisify(execFile);
const canonicalGuideRoot = process.env.GOVSTACK_API_GUIDE_SOURCE_ROOT && path.resolve(process.env.GOVSTACK_API_GUIDE_SOURCE_ROOT);
const adapterPath = path.resolve(import.meta.dirname, '../adapters/api-guide.mjs');

async function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function snapshotGuideInputs(sourceRoot) {
  const summary = await readFile(path.join(sourceRoot, 'SUMMARY.md'));
  const pageSources = [...summary.toString('utf8').matchAll(/^\s*\*\s+\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]*)?\)\s*$/gm)].map(
    (match) => match[1],
  );
  const sources = ['SUMMARY.md', ...pageSources, 'rules.yaml', 'linter/coverage.yaml'];
  return new Map(
    await Promise.all(
      sources.map(async (source) => [source, await readFile(path.join(sourceRoot, source))]),
    ),
  );
}

function digestSnapshots(inputs) {
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

async function assertSnapshotsUnchanged(sourceRoot, before) {
  for (const [source, contents] of before) {
    assert.equal(
      (await readFile(path.join(sourceRoot, source))).compare(contents),
      0,
      `${source} changed during generation`,
    );
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guide-adapter-'));
  const sourceRoot = path.join(root, 'api-design-guide');
  const siteRoot = path.join(root, 'api-design-guide-site');

  await write(sourceRoot, 'SUMMARY.md', `# Contents

* [Guide home](README.md)

## Guides

* [About the guides](guides/README.md)
* [A practical guide](guides/practical.md)
`);
  await write(sourceRoot, 'README.md', `---
description: "Fixture home."
---

# Guide home <a href="#permanent-home" id="permanent-home"></a>

{% hint style="warning" %}
This is a draft.
{% endhint %}

[Guides](guides/README.md#stable-guides), [rules](rules.yaml), and [the linter](linter/README.md).

Inline \`[literal](guides/README.md)\` stays literal.

\`\`\`md
[literal](guides/README.md)
\`\`\`
`);
  await write(sourceRoot, 'guides/README.md', `---
description: "Guide group landing page."
---

# About the guides

## Renamed heading <a href="#stable-guides" id="stable-guides"></a>

See [the practical guide](practical.md#stable-practical) and [coverage](../linter/coverage.yaml).
`);
  await write(sourceRoot, 'guides/practical.md', `---
description: "A practical fixture page."
---

# A practical guide

{% hint style="info" %}
Useful information.
{% endhint %}

## Changed words <a href="#stable-practical" id="stable-practical"></a>
`);
  await write(sourceRoot, 'rules.yaml', 'version: 9.8.7-test\n');
  await write(sourceRoot, 'linter/coverage.yaml', 'guide_version: 9.8.7-test\n');
  await write(sourceRoot, 'linter/README.md', '# Linter\n');

  await execFileAsync('git', ['init', '-q', root]);
  await execFileAsync('git', ['-C', root, 'add', 'api-design-guide']);
  await execFileAsync(
    'git',
    ['-C', root, '-c', 'user.name=Guide Test', '-c', 'user.email=guide@example.invalid', 'commit', '-qm', 'fixture'],
  );

  return { root, sourceRoot, siteRoot };
}

test('shared adapter module has no standalone CLI behavior', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [adapterPath]);
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('remarkGuideAnchors promotes an explicit heading anchor to the rendered heading id', () => {
  const tree = {
    type: 'root',
    children: [
      {
        type: 'heading',
        depth: 2,
        children: [
          { type: 'text', value: 'A renamed heading ' },
          { type: 'html', value: '<a href="#stable-id" id="stable-id">' },
          { type: 'html', value: '</a>' },
        ],
      },
    ],
  };

  remarkGuideAnchors()(tree);

  assert.equal(tree.children[0].data.hProperties.id, 'stable-id');
  assert.deepEqual(tree.children[0].children, [{ type: 'text', value: 'A renamed heading' }]);
});

test('generateSite derives source links from sourceUrl and honours unofficial robots', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  await generateSite({ sourceRoot, siteRoot, sourceUrl: 'https://github.com/jeremi/govstack-api-design-guide/blob/main', unofficial: true });
  const home = await readFile(path.join(siteRoot, 'src/content/docs/index.md'), 'utf8');
  assert.match(home, /editUrl: https:\/\/github\.com\/jeremi\/govstack-api-design-guide\/edit\/main\/README\.md/);
  assert.match(home, /\(https:\/\/github\.com\/jeremi\/govstack-api-design-guide\/blob\/main\/linter\/README\.md\)/);
  assert.match(home, /content: noindex, nofollow/);
  assert.doesNotMatch(home, /GovStackWorkingGroup/);
});

test('generateSite builds frontmatter, routes, downloads, links, asides, and stable anchors', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const before = await readFile(path.join(sourceRoot, 'README.md'), 'utf8');
  const inputSnapshots = await snapshotGuideInputs(sourceRoot);

  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/standards/api/' });

  assert.equal(manifest.version, '9.8.7-test');
  assert.equal(manifest.sourceDigest, digestSnapshots(inputSnapshots));
  assert.equal(manifest.sourceDirty, false);
  assert.match(manifest.sourceRevision, /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.sidebar, [
    { label: 'Guide home', slug: '' },
    {
      label: 'Guides',
      items: [
        { label: 'About the guides', slug: 'guides' },
        { label: 'A practical guide', slug: 'guides/practical' },
      ],
    },
  ]);
  assert.deepEqual(
    manifest.pages.map(({ source, route, title }) => ({ source, route, title })),
    [
      { source: 'README.md', route: '', title: 'Guide home' },
      { source: 'guides/README.md', route: 'guides', title: 'About the guides' },
      { source: 'guides/practical.md', route: 'guides/practical', title: 'A practical guide' },
    ],
  );
  assert.deepEqual(manifest.pages[1].anchors, [
    { depth: 1, text: 'About the guides', id: 'about-the-guides' },
    { depth: 2, text: 'Renamed heading', id: 'stable-guides' },
  ]);

  const generatedHome = await readFile(path.join(siteRoot, 'src/content/docs/index.md'), 'utf8');
  assert.match(generatedHome, /^---\ntitle: Guide home\n/);
  assert.match(generatedHome, /description: Fixture home\./);
  assert.match(
    generatedHome,
    /editUrl: https:\/\/github\.com\/GovStackWorkingGroup\/bb-template\/edit\/main\/api-design-guide\/README\.md/,
  );
  assert.match(generatedHome, /content: noindex, follow/);
  assert.doesNotMatch(generatedHome, /^# Guide home/m);
  assert.match(generatedHome, /<a id="permanent-home"><\/a>/);
  assert.match(generatedHome, /:::caution\nThis is a draft\.\n:::/);
  assert.match(generatedHome, /\[Guides\]\(\/standards\/api\/guides#stable-guides\)/);
  assert.match(generatedHome, /\[rules\]\(\/standards\/api\/downloads\/rules\.yaml\)/);
  assert.match(
    generatedHome,
    /\[the linter\]\(https:\/\/github\.com\/GovStackWorkingGroup\/bb-template\/blob\/main\/api-design-guide\/linter\/README\.md\)/,
  );
  assert.match(generatedHome, /Inline `\[literal\]\(guides\/README\.md\)` stays literal\./);
  assert.match(generatedHome, /```md\n\[literal\]\(guides\/README\.md\)\n```/);

  assert.equal(
    await readFile(path.join(siteRoot, 'public/downloads/rules.yaml'), 'utf8'),
    'version: 9.8.7-test\n',
  );
  assert.equal(
    await readFile(path.join(siteRoot, 'public/downloads/linter/coverage.yaml'), 'utf8'),
    'guide_version: 9.8.7-test\n',
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(siteRoot, 'src/data/generated/guide.json'), 'utf8')),
    manifest,
  );
  assert.equal(await readFile(path.join(sourceRoot, 'README.md'), 'utf8'), before);
});

test('site-only changes do not mark the canonical guide dirty', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  await mkdir(siteRoot, { recursive: true });
  await writeFile(path.join(siteRoot, 'untracked.txt'), 'site-only\n');
  const cleanManifest = await generateSite({ sourceRoot, siteRoot });
  assert.equal(cleanManifest.sourceDirty, false);
  await writeFile(path.join(sourceRoot, 'rules.yaml'), 'version: 9.8.8-test\n');
  const dirtyManifest = await generateSite({ sourceRoot, siteRoot });
  assert.equal(dirtyManifest.sourceDirty, true);
  assert.notEqual(dirtyManifest.sourceDigest, cleanManifest.sourceDigest);
});

test('SUMMARY remains the manifest allowlist when an arbitrary generated Markdown file survives', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const orphan = path.join(siteRoot, 'src/content/docs/orphan.md');
  await mkdir(path.dirname(orphan), { recursive: true });
  await writeFile(orphan, '# Orphan\n');

  const manifest = await generateSite({ sourceRoot, siteRoot });

  assert.equal(manifest.pages.some((page) => page.route === 'orphan'), false);
  assert.equal(await readFile(orphan, 'utf8'), '# Orphan\n');
});

test('repeated generation prunes only pages removed from the previous generated manifest', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  await generateSite({ sourceRoot, siteRoot });
  const removedOutput = path.join(siteRoot, 'src/content/docs/guides/practical.md');
  assert.match(await readFile(removedOutput, 'utf8'), /A practical guide/);

  await writeFile(
    path.join(sourceRoot, 'SUMMARY.md'),
    '# Contents\n\n* [Guide home](README.md)\n\n## Guides\n\n* [About the guides](guides/README.md)\n',
  );
  await writeFile(
    path.join(sourceRoot, 'guides/README.md'),
    '---\ndescription: "Guide group landing page."\n---\n\n# About the guides\n\n## Renamed heading <a href="#stable-guides" id="stable-guides"></a>\n',
  );
  await generateSite({ sourceRoot, siteRoot });

  await assert.rejects(readFile(removedOutput, 'utf8'), { code: 'ENOENT' });
  assert.match(await readFile(path.join(siteRoot, 'src/content/docs/guides.md'), 'utf8'), /About the guides/);
});

test('the canonical guide integration generates all 32 allowlisted pages without changing a source byte', async (t) => {
  if (!canonicalGuideRoot) return t.skip('GOVSTACK_API_GUIDE_SOURCE_ROOT is not set');
  const siteRoot = await mkdtemp(path.join(os.tmpdir(), 'canonical-guide-site-'));
  const before = await snapshotGuideInputs(canonicalGuideRoot);
  const [{ stdout: topLevel }, { stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['-C', canonicalGuideRoot, 'rev-parse', '--show-toplevel']),
    execFileAsync('git', ['-C', canonicalGuideRoot, 'rev-parse', 'HEAD']),
    execFileAsync('git', [
      '-C',
      canonicalGuideRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      '.',
    ]),
  ]);
  const sourcePath = path.relative(topLevel.trim(), canonicalGuideRoot) || '.';
  const { stdout: sourceStatus } = await execFileAsync('git', [
    '-C',
    topLevel.trim(),
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    sourcePath,
  ]);
  const version = /^version:\s*["']?([^"'\s]+)/m.exec(before.get('rules.yaml').toString('utf8'))?.[1];

  const manifest = await generateSite({ sourceRoot: canonicalGuideRoot, siteRoot, base: '/' });

  assert.equal(manifest.pages.length, 32);
  assert.equal(manifest.version, version);
  assert.equal(manifest.sourceRevision, revision.trim());
  assert.equal(manifest.sourceDirty, sourceStatus.trim() !== '');
  assert.equal(status.trim() !== '', sourceStatus.trim() !== '');
  assert.equal(manifest.sourceDigest, digestSnapshots(before));
  await assertSnapshotsUnchanged(canonicalGuideRoot, before);
});

for (const [name, mutate, expected] of [
  [
    'missing allowlisted page',
    async ({ sourceRoot }) => writeFile(path.join(sourceRoot, 'SUMMARY.md'), '* [Missing](missing.md)\n'),
    /missing allowlisted page/i,
  ],
  [
    'unknown relative link target',
    async ({ sourceRoot }) =>
      writeFile(
        path.join(sourceRoot, 'README.md'),
        '---\ndescription: Broken.\n---\n\n# Broken\n\n[Unknown](not-allowlisted.md)\n',
      ),
    /unknown relative link target/i,
  ],
  [
    'unsupported hint style',
    async ({ sourceRoot }) =>
      writeFile(
        path.join(sourceRoot, 'README.md'),
        '---\ndescription: Broken.\n---\n\n# Broken\n\n{% hint style="success" %}\nNo.\n{% endhint %}\n',
      ),
    /unsupported hint style/i,
  ],
  [
    'malformed hint',
    async ({ sourceRoot }) =>
      writeFile(
        path.join(sourceRoot, 'README.md'),
        '---\ndescription: Broken.\n---\n\n# Broken\n\n{% hint style="info" %}\nUnclosed.\n',
      ),
    /malformed hint/i,
  ],
]) {
  test(`generateSite fails on ${name}`, async () => {
    const values = await fixture();
    await mutate(values);
    await assert.rejects(generateSite(values), expected);
  });
}
