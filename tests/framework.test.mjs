import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { generateSite, routeFor } from '../adapters/framework.mjs';
import { isPublishableSupportPath } from '../scripts/support-paths.mjs';

const execFileAsync = promisify(execFile);
const canonicalSourceRoot = process.env.GOVSTACK_FRAMEWORK_SOURCE_ROOT && path.resolve(process.env.GOVSTACK_FRAMEWORK_SOURCE_ROOT);
const adapterPath = path.resolve(import.meta.dirname, '../adapters/framework.mjs');

async function write(root, relative, contents) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'registries-starlight-'));
  const sourceRoot = path.join(root, 'source');
  const siteRoot = path.join(root, 'site');
  await write(sourceRoot, 'toc.yml', `toc:
  requirements:
    - service.md
  resources:
    - testing.md
`);
  await write(sourceRoot, 'metadata.yml', `name: Digital Registries
abstract: A fixture Registry specification.
url: https://example.invalid/registries/
repository: https://github.com/example/registries
urn: govstack:spec:bb:registries
owner_group: govstack:wg:registries
capabilities:
  - id: registry-services
    title: Registry Services
    description: Provides Registry operations.
extensions: []
versions:
  - version: 9.8.7-draft
    release_date:
    short_description: Fixture authoring draft.
    latest: true
`);
  await write(sourceRoot, 'authors.yml', `authors:
  - name: Example Author
    roles: [Author]
    urn: govstack:person:example
`);
  await write(sourceRoot, 'README.md', `# Digital Registries

[Linked document](resources/linked.md#linked-heading).

[Extension downloads](api/extensions/).

<figure><img src="assets/diagram.svg" alt="Fixture diagram"></figure>
`);
  await write(sourceRoot, 'requirements/service.md', `---
title: Provide Registry Services
description: Consumers use declared Registry services.
realises: [registry-services]
conformance: EXTENSION
requirements:
  - id:
    key: registry-service
    status: DRAFT
    level: REQUIRED
    observability: OBSERVABLE
    mutability: EXTENSIBLE
    statement: Provide at least one service.
    documentation: |
      Purpose: Establish a useful service.
      Constraint: Select at least one passing option.
      Verification: Count passing options.
    select: {min: 1}
  - id:
    key: consultation-retrieve
    option_of: registry-service
    status: DRAFT
    observability: OBSERVABLE
    mutability: EXTENSIBLE
    interaction: SERVICE_API
    contract: resources/api.yml
    api_operation_id: retrieveRecord
    statement: Retrieve one Record.
    documentation: |
      Condition: The option is selected.
      Constraint: Preserve source meaning.
      Evidence: A response fixture.
      Verification: Exercise the fixture.
    test: resources/testing.md#consultation-1
  - id:
    status: DRAFT
    level: REQUIRED
    observability: OBSERVABLE
    mutability: EXTENSIBLE
    interaction: SERVICE_API
    applies_when: [consultation-retrieve, consultation-lookup]
    statement: Return the declared representation.
    documentation: |
      Condition: Retrieve is selected.
      Constraint: Use the declared schema.
      Verification: Validate one response.
  - id:
    status: DRAFT
    level: REQUIRED
    observability: OBSERVABLE
    mutability: EXTENSIBLE
    applies_when_all: [consultation-list, audit-profile]
    statement: Apply the combined profile rules.
    documentation: |
      Condition: Both selections are active.
      Constraint: Apply both declared conditions.
      Verification: Exercise the combined profile.
---

# Consultation workflow

The source Registry remains authoritative.
`);
  await write(sourceRoot, 'resources/testing.md', `# Testing

<a id="consultation-1"></a>

## Consultation 1

Run the fixture.
`);
  await write(sourceRoot, 'resources/linked.md', `# Linked support

## Linked heading

Supporting text.
`);
  await write(sourceRoot, 'assets/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Diagram</title></svg>\n');
  await write(sourceRoot, 'api/openapi.yaml', 'openapi: 3.1.0\n');
  await write(sourceRoot, 'api/extensions/example.schema.json', '{"type":"object"}\n');
  await write(sourceRoot, 'api/common/govstack-openapi-common.yaml', 'components: {}\n');
  await mkdir(path.join(sourceRoot, 'resources'), { recursive: true });
  await symlink('../api/openapi.yaml', path.join(sourceRoot, 'resources/api.yml'));
  await symlink('../api/common', path.join(sourceRoot, 'resources/common'));

  await execFileAsync('git', ['init', '-q', root]);
  await execFileAsync('git', ['-C', root, 'add', 'source']);
  await execFileAsync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, sourceRoot, siteRoot };
}

test('shared adapter module has no standalone CLI behavior', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [adapterPath]);
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('routeFor creates Starlight routes for home, nested READMEs, and ordinary pages', () => {
  assert.equal(routeFor('README.md'), '');
  assert.equal(routeFor('resources/README.md'), 'resources');
  assert.equal(routeFor('requirements/service.md'), 'requirements/service');
  assert.equal(routeFor('resources/migration-from-3.0.md'), 'resources/migration-from-30');
});

test('support path policy allows public compatibility paths and rejects hidden config', () => {
  for (const allowed of [
    'api/openapi.yaml',
    '.github/workflows/validate.yml',
    '.well-known/api-catalog',
    'api/extensions/.well-known/catalog.json',
  ]) {
    assert.equal(isPublishableSupportPath(allowed), true, allowed);
  }
  for (const forbidden of [
    '.git/config',
    '.venv/pyvenv.cfg',
    'examples/openIMIS/.env',
    'api/extensions/.env.example',
    'api/extensions/.npmrc',
    'api/extensions/.secrets/config',
  ]) {
    assert.equal(isPublishableSupportPath(forbidden), false, forbidden);
  }
});

test('generator rewrites routes, renders requirement semantics, copies aliases, and records provenance', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/' });

  assert.equal(manifest.pages.length, 4);
  assert.equal(manifest.requirementCount, 4);
  assert.equal(manifest.version, '9.8.7-draft');
  assert.match(manifest.sourceRevision, /^[0-9a-f]{40}$/);
  assert.match(manifest.sourceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(manifest.sidebar[0], { label: 'Home', slug: '' });

  const home = await readFile(path.join(siteRoot, 'src/content/docs/index.md'), 'utf8');
  assert.match(home, /\[Linked document\]\(\/resources\/linked\/#linked-heading\)/);
  assert.match(home, /src="\/assets\/diagram\.svg"/);
  assert.match(home, /\[Extension downloads\]\(\/api\/extensions\/\)/);
  assert.doesNotMatch(home, /^# Digital Registries$/m);
  assert.match(home, /## Specification metadata/);
  assert.match(home, /Example Author/);

  const requirements = await readFile(path.join(siteRoot, 'src/content/docs/requirements/service.md'), 'utf8');
  assert.match(requirements, /^title: Provide Registry Services$/m);
  assert.doesNotMatch(requirements, /^# Provide Registry Services$/m);
  assert.match(requirements, /^## Consultation workflow$/m);
  assert.equal((requirements.match(/class="requirement-draft-id">Unnumbered draft/g) ?? []).length, 4);
  assert.match(requirements, /class="requirement-card variation-point"/);
  assert.match(requirements, /class="requirement-card-title requirement-statement"/);
  assert.equal((requirements.match(/Retrieve one Record\./g) ?? []).length, 1);
  assert.match(requirements, /class="requirement-key-row">[\s\S]*registry-service/);
  assert.match(requirements, /Option of/);
  assert.match(requirements, /Inherited option obligation/);
  assert.match(requirements, /Any of/);
  assert.match(requirements, /All of/);
  assert.match(requirements, /<dt>Type<\/dt><dd>Extension<\/dd>/);
  assert.match(requirements, /consultation-retrieve/);
  assert.match(requirements, /class="requirement-documentation requirement-constraint">[\s\S]*Preserve source meaning/);
  assert.match(requirements, /<details class="requirement-proof">[\s\S]*Evidence[\s\S]*Verification/);
  assert.match(requirements, /href="\/resources\/testing\/#consultation-1"/);
  assert.match(requirements, /href="\/resources\/api\.yml"/);

  assert.equal((await lstat(path.join(siteRoot, 'public/resources/api.yml'))).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(siteRoot, 'public/resources/api.yml'), 'utf8'), 'openapi: 3.1.0\n');
  assert.equal(
    await readFile(path.join(siteRoot, 'public/resources/common/govstack-openapi-common.yaml'), 'utf8'),
    'components: {}\n',
  );
  assert.match(
    await readFile(path.join(siteRoot, 'public/requirements/service.html'), 'utf8'),
    /url=\/requirements\/service\//,
  );
  assert.match(
    await readFile(path.join(siteRoot, 'public/api/extensions/index.html'), 'utf8'),
    /example\.schema\.json/,
  );
});

test('home metadata renders structured extensions and null author URNs faithfully', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const metadataPath = path.join(sourceRoot, 'metadata.yml');
  const authorsPath = path.join(sourceRoot, 'authors.yml');
  const metadata = `${await readFile(metadataPath, 'utf8')}`.replace(
    'extensions: []',
    `extensions:
  - legacy-extension
  - id: audit-profile
    title: Audit Profile
    description: Adds an optional audit profile.
    requires: [registry-services, registry-discovery]
  - id: event-profile
    title: Event Profile`,
  );
  const authors = `authors:
  - name: Example Author
    roles: [Author]
    urn:
`;
  await writeFile(metadataPath, metadata);
  await writeFile(authorsPath, authors);
  const before = new Map([
    [metadataPath, await readFile(metadataPath)],
    [authorsPath, await readFile(authorsPath)],
  ]);

  await generateSite({ sourceRoot, siteRoot, base: '/' });

  const home = await readFile(path.join(siteRoot, 'src/content/docs/index.md'), 'utf8');
  assert.match(home, /legacy-extension/);
  assert.match(home, /Audit Profile \(`audit-profile`\)/);
  assert.match(home, /Adds an optional audit profile\./);
  assert.match(home, /Requires: `registry-services`, `registry-discovery`\./);
  assert.match(home, /Event Profile \(`event-profile`\)/);
  assert.match(home, /\| Example Author \| Author \|\s+\|/);
  assert.doesNotMatch(home, /\[object Object\]|undefined|null/);

  for (const [source, contents] of before) {
    assert.equal((await readFile(source)).compare(contents), 0, `${path.basename(source)} changed`);
  }
});

test('unofficial generation marks pages, redirects, and download indexes nofollow', async () => {
  const official = await fixture();
  await generateSite({ sourceRoot: official.sourceRoot, siteRoot: official.siteRoot, base: '/' });
  const unofficial = await fixture();
  await generateSite({ sourceRoot: unofficial.sourceRoot, siteRoot: unofficial.siteRoot, base: '/', unofficial: true });
  const files = ['src/content/docs/index.md', 'public/requirements/service.html', 'public/api/extensions/index.html'];
  for (const file of files) {
    assert.doesNotMatch(await readFile(path.join(official.siteRoot, file), 'utf8'), /nofollow/, file);
    assert.match(await readFile(path.join(unofficial.siteRoot, file), 'utf8'), /noindex, nofollow/, file);
  }
  assert.match(await readFile(path.join(official.siteRoot, 'public/requirements/service.html'), 'utf8'), /content="noindex"/);
});

test('implicit heading anchors retain decoded trailing spaces used by native Astro slugs', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const sourcePath = path.join(sourceRoot, 'resources/testing.md');
  const source = `${await readFile(sourcePath, 'utf8')}`.replace('# Testing', '# Testing&#x20;') + `
### Comply with high quality data protection principles&#x20;

### Deleting records based on a defined procedure and governing law&#x20;

### Explicit title&#x20; <a href="#stable-explicit" id="stable-explicit"></a>
`;
  await writeFile(sourcePath, source);
  const before = await readFile(sourcePath);

  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/' });

  const page = manifest.pages.find(({ source: name }) => name === 'resources/testing.md');
  assert.equal(page.title, 'Testing');
  assert.deepEqual(
    page.anchors.map(({ id }) => id),
    [
      'testing-',
      'consultation-1',
      'comply-with-high-quality-data-protection-principles-',
      'deleting-records-based-on-a-defined-procedure-and-governing-law-',
      'stable-explicit',
    ],
  );
  assert.equal((await readFile(sourcePath)).compare(before), 0, 'heading source bytes changed');
});

test('support files omit hidden operational config without changing source bytes', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const readmePath = path.join(sourceRoot, 'README.md');
  await writeFile(
    readmePath,
    `${await readFile(readmePath, 'utf8')}\n[Validation workflow](.github/workflows/validate.yml).\n`,
  );
  const sources = new Map([
    ['api/extensions/extra.schema.json', '{"type":"string"}\n'],
    ['api/extensions/.well-known/catalog.json', '{"catalog":true}\n'],
    ['.github/workflows/validate.yml', 'name: fixture validation\n'],
    ['examples/openIMIS/.env', 'FIXTURE_ONLY=env\n'],
    ['api/extensions/.env.example', 'FIXTURE_ONLY=example\n'],
    ['api/extensions/.npmrc', 'fixture-only=true\n'],
    ['api/extensions/.secrets/config', 'fixture-only-config\n'],
  ]);
  for (const [relative, contents] of sources) await write(sourceRoot, relative, contents);
  const before = new Map(
    await Promise.all(
      [...sources.keys(), 'README.md'].map(async (relative) => [
        relative,
        await readFile(path.join(sourceRoot, relative)),
      ]),
    ),
  );

  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/' });

  for (const allowed of [
    'api/extensions/extra.schema.json',
    'api/extensions/.well-known/catalog.json',
    '.github/workflows/validate.yml',
  ]) {
    assert.equal(manifest.supportFiles.includes(allowed), true, `${allowed} must remain published`);
    assert.equal(
      (await readFile(path.join(siteRoot, 'public', allowed))).compare(before.get(allowed)),
      0,
      `${allowed} output must preserve source bytes`,
    );
  }

  for (const forbidden of [
    'examples/openIMIS/.env',
    'api/extensions/.env.example',
    'api/extensions/.npmrc',
    'api/extensions/.secrets/config',
  ]) {
    assert.equal(manifest.supportFiles.includes(forbidden), false, `${forbidden} must not be published`);
    await assert.rejects(readFile(path.join(siteRoot, 'public', forbidden)), { code: 'ENOENT' });
  }

  const extensionIndex = await readFile(
    path.join(siteRoot, 'public/api/extensions/index.html'),
    'utf8',
  );
  assert.match(extensionIndex, /extra\.schema\.json/);
  assert.match(extensionIndex, />\.well-known\/<\/a>/);
  assert.doesNotMatch(extensionIndex, /\.env|\.npmrc|\.secrets/);

  for (const [relative, contents] of before) {
    assert.equal(
      (await readFile(path.join(sourceRoot, relative))).compare(contents),
      0,
      `${relative} source bytes changed`,
    );
  }
});

test('generator rejects a referenced hidden operational config path', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const readmePath = path.join(sourceRoot, 'README.md');
  await write(sourceRoot, 'examples/openIMIS/.env.example', 'FIXTURE_ONLY=example\n');
  await writeFile(
    readmePath,
    `${await readFile(readmePath, 'utf8')}\n[Operational config](examples/openIMIS/.env.example).\n`,
  );

  await assert.rejects(
    generateSite({ sourceRoot, siteRoot, base: '/' }),
    /refusing referenced hidden operational\/config path.*examples\/openIMIS\/\.env\.example/i,
  );
});

test('generator rejects a visible referenced symlink to hidden operational config', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const readmePath = path.join(sourceRoot, 'README.md');
  await write(sourceRoot, '.secrets/config', 'fixture-only-config\n');
  await symlink('../.secrets/config', path.join(sourceRoot, 'resources/public-config.txt'));
  await writeFile(
    readmePath,
    `${await readFile(readmePath, 'utf8')}\n[Public config alias](resources/public-config.txt).\n`,
  );

  await assert.rejects(
    generateSite({ sourceRoot, siteRoot, base: '/' }),
    /refusing referenced support symlink.*resources\/public-config\.txt.*hidden operational\/config/i,
  );
});

test('generator rejects a referenced directory symlink to hidden operational config', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const readmePath = path.join(sourceRoot, 'README.md');
  await write(sourceRoot, '.secrets/child.txt', 'fixture-only-config\n');
  await symlink('../.secrets', path.join(sourceRoot, 'resources/public-files'));
  await writeFile(
    readmePath,
    `${await readFile(readmePath, 'utf8')}\n[Public files](resources/public-files/).\n[Child file](resources/public-files/child.txt).\n`,
  );

  await assert.rejects(
    generateSite({ sourceRoot, siteRoot, base: '/' }),
    /refusing referenced support symlink.*resources\/public-files.*hidden operational\/config/i,
  );
});

test('canonical source integration renders all 39 requirements without changing source state', async (t) => {
  if (!canonicalSourceRoot) return t.skip('GOVSTACK_FRAMEWORK_SOURCE_ROOT is not set');
  const siteRoot = await mkdtemp(path.join(os.tmpdir(), 'registries-canonical-site-'));
  const [beforeRevision, beforeStatus] = await Promise.all([
    execFileAsync('git', ['--no-optional-locks', '-C', canonicalSourceRoot, 'rev-parse', 'HEAD']),
    execFileAsync('git', [
      '--no-optional-locks',
      '-C',
      canonicalSourceRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]),
  ]);

  const manifest = await generateSite({ sourceRoot: canonicalSourceRoot, siteRoot, base: '/' });

  assert.equal(manifest.requirementCount, 39);
  assert.equal(manifest.pages.length, 34);
  assert.equal(manifest.sourceRevision, beforeRevision.stdout.trim());
  assert.equal(manifest.sourceDirty, beforeStatus.stdout.trim() !== '');
  assert.equal(manifest.pages.some((page) => page.route === 'requirements/registry-services'), true);
  const requirements = await readFile(
    path.join(siteRoot, 'src/content/docs/requirements/registry-services.md'),
    'utf8',
  );
  assert.equal((requirements.match(/<article class="requirement-card /g) ?? []).length, 35);
  assert.equal((requirements.match(/class="requirement-card-title requirement-statement"/g) ?? []).length, 35);
  assert.equal((requirements.match(/class="requirement-draft-id">Unnumbered draft/g) ?? []).length, 35);
  assert.match(requirements, /Any of/);
  assert.match(requirements, /Minimum selections/);

  for (const archive of [
    'resources/history/release-notes.md',
    'resources/history/requirements.md',
    'api/legacy/generated-crud.md',
  ]) {
    const renderedArchive = await readFile(path.join(siteRoot, 'src/content/docs', archive), 'utf8');
    assert.match(renderedArchive, /^pagefind: false$/m, `${archive} must stay out of default search`);
  }

  const [afterRevision, afterStatus] = await Promise.all([
    execFileAsync('git', ['--no-optional-locks', '-C', canonicalSourceRoot, 'rev-parse', 'HEAD']),
    execFileAsync('git', [
      '--no-optional-locks',
      '-C',
      canonicalSourceRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]),
  ]);
  assert.equal(afterRevision.stdout, beforeRevision.stdout);
  assert.equal(afterStatus.stdout, beforeStatus.stdout);
});
