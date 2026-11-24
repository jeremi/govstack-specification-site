import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { generateSite } from '../adapters/framework.mjs';
import { parseToc } from '../adapters/framework-model.mjs';

const execFileAsync = promisify(execFile);

async function write(root, relative, contents) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

const TOC = `toc:
  introduction:
    - purpose.md
    - terminology.yml
    - references.yml
  conformance-profiles:
    - core-profile:
        - introduction.md
        - functionalities/functionality-a.md
    - extension-x:
        - introduction.md
        - functionalities/functionality-x.md
    - extension-y:
        - introduction.md
        - functionalities/functionality-y.md
  resources:
    - tests/
`;

// An abstract Building Block, as the Specification Framework's examples use: one
// core and two extensions, a variation point with an option met by an extension,
// and requirements conditional on an option key and on an extension id.
async function fixture({ toc = TOC, files = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conformance-profiles-'));
  const sourceRoot = path.join(root, 'source');
  const siteRoot = path.join(root, 'site');
  const sources = {
    'toc.yml': toc,
    'metadata.yml': `name: Example Building Block
abstract: An abstract Building Block.
urn: govstack:spec:bb:example
capabilities:
  - id: capability-one
    title: Capability One
    description: Does one thing.
extensions:
  - id: stale
versions:
  - version: 2.0.0-draft
    latest: true
`,
    'authors.yml': 'authors:\n  - name: Example Author\n    roles: [Author]\n',
    'README.md': '# Example\n\nAn example.\n',
    'introduction/purpose.md': '# Purpose\n\nWhy.\n',
    'introduction/terminology.yml': `terms:
  - term: Example Term
    abbreviation: ET
    definition: A term used in examples.
    source: ISO 1234, 3.1
    notes: [A note to entry.]
`,
    'introduction/references.yml': `- title: Example Standard
  url: https://example.invalid/standard
  date: 2026
  abstract: A standard.
`,
    'conformance-profiles/core-profile/introduction.md': `---
title: Core Profile
type: CORE
description: What every conformant software solution does.
requires: []
role: Role A
---

## Functionalities

| Functionality | Description |
|---|---|
| [Functionality A](functionalities/functionality-a.md) | Does A. |
`,
    'conformance-profiles/core-profile/functionalities/functionality-a.md': `---
title: Functionality A
description: |
  Does A.
realises: [capability-one]
conformance: CORE
requirements:
  - id: '30'
    status: PUBLISHED
    level: REQUIRED
    mutability: EXTENSIBLE
    statement: The solution handles at least one of the kinds in requirements 30.1 to 30.3.
    documentation:
    select:
      min: 1
    options:
      - id: '30.1'
        key: kind-one
        status: PUBLISHED
        level: OPTION
        interaction: FILE
        statement: The solution handles kind one.
        test: resources/tests/kind-one.feature
      - id: '30.2'
        key: kind-two
        status: DRAFT
        level: OPTION
        interaction: SERVICE_API
        presented_by: [kind-one]
        statement: The solution handles kind two.
      - id: '30.3'
        key: kind-x
        status: DRAFT
        level: OPTION
        extension: extension-x
        statement: The solution handles kind x as Extension X specifies.
  - id: '31'
    status: PUBLISHED
    level: REQUIRED
    interaction: FILE
    applies_when: [kind-one]
    statement: The solution checks kind one before keeping it.
  - id: '32'
    status: PUBLISHED
    level: RECOMMENDED
    interaction: INTERNAL
    observability: OBSERVABLE
    applies_when: [extension-y]
    statement: The solution keeps a record when Extension Y is claimed.
---

Explanation of A.
`,
    'conformance-profiles/extension-x/introduction.md': `---
title: Extension X
type: EXTENSION
description: Adds X.
requires: []
reference_architecture: govstack:ra:example
---

[Functionality X](functionalities/functionality-x.md)
`,
    'conformance-profiles/extension-x/functionalities/functionality-x.md': `---
title: Functionality X
description: Does X.
requirements:
  - id: '40'
    status: PUBLISHED
    level: REQUIRED
    interaction: PROTOCOL
    statement: The solution speaks protocol X.
---
`,
    'conformance-profiles/extension-y/introduction.md': `---
title: Extension Y
type: EXTENSION
description: Adds Y.
requires: [extension-x]
---

No table yet.
`,
    'conformance-profiles/extension-y/functionalities/functionality-y.md': `---
title: Functionality Y
description: Does Y.
requirements:
  - id: '50'
    status: DRAFT
    level: REQUIRED
    statement: The solution does Y.
---
`,
    'resources/tests/kind-one.feature': 'Feature: kind one\n',
    ...files,
  };
  for (const [relative, contents] of Object.entries(sources)) {
    if (contents !== null) await write(sourceRoot, relative, contents);
  }
  await execFileAsync('git', ['init', '-q', root]);
  await execFileAsync('git', ['-C', root, 'add', 'source']);
  await execFileAsync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return { sourceRoot, siteRoot };
}

const page = (siteRoot, route) => readFile(path.join(siteRoot, 'src/content/docs', `${route}.md`), 'utf8');

test('toc subsections under conformance-profiles resolve relative to each profile folder', () => {
  const model = parseToc({
    introduction: ['purpose.md'],
    'conformance-profiles': [{ core: ['introduction.md', 'functionalities/a.md'] }],
    resources: null,
  });
  assert.deepEqual(model.profiles, [
    {
      id: 'core',
      directory: 'conformance-profiles/core',
      introduction: 'conformance-profiles/core/introduction.md',
      pages: ['conformance-profiles/core/introduction.md', 'conformance-profiles/core/functionalities/a.md'],
    },
  ]);
  assert.deepEqual(model.sections.at(-1), { key: 'resources', items: [] });
  assert.throws(() => parseToc({ 'conformance-profiles': ['loose.md'] }), /one subsection per profile folder/);
  assert.throws(() => parseToc({ 'conformance-profiles': [{ Core: ['introduction.md'] }] }), /kebab-case/);
  assert.throws(() => parseToc({ 'conformance-profiles': [{ core: ['functionalities/a.md', 'introduction.md'] }] }), /introduction\.md first/);
  assert.throws(() => parseToc({ 'conformance-profiles': [{ core: ['introduction.md', { nested: ['b.md'] }] }] }), /one level deep/);
  assert.throws(() => parseToc({ introduction: ['a.md', 'a.md'] }), /listed twice/);
});

test('conformance profiles get their own pages, navigation and home table', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/docs/' });

  assert.deepEqual(
    manifest.profiles.map(({ id, type, route, requires }) => [id, type, route, requires]),
    [
      ['core-profile', 'CORE', 'conformance-profiles/core-profile', []],
      ['extension-x', 'EXTENSION', 'conformance-profiles/extension-x', []],
      ['extension-y', 'EXTENSION', 'conformance-profiles/extension-y', ['extension-x']],
    ],
  );
  const section = manifest.sidebar.find(({ label }) => label === 'Conformance profiles');
  assert.deepEqual(section.items[0], {
    label: 'Core Profile',
    badge: { text: 'Core', variant: 'note' },
    items: [
      { label: 'Introduction', slug: 'conformance-profiles/core-profile' },
      { label: 'Functionality A', slug: 'conformance-profiles/core-profile/functionalities/functionality-a' },
    ],
  });
  assert.equal(section.items[1].badge.text, 'Extension');
  assert.deepEqual(section.items.at(-1), { label: 'Options and conditions', slug: 'conformance-profiles/options-and-conditions' });

  const extensionY = await page(siteRoot, 'conformance-profiles/extension-y');
  assert.match(extensionY, /class="functionality-summary profile-summary"/);
  assert.match(extensionY, /<dt>Builds on<\/dt><dd><a href="\/docs\/conformance-profiles\/core-profile\/">Core Profile<\/a>, <a href="\/docs\/conformance-profiles\/extension-x\/">Extension X<\/a><\/dd>/);
  const extensionX = await page(siteRoot, 'conformance-profiles/extension-x');
  assert.match(extensionX, /<dt>Reference architecture<\/dt><dd><code>govstack:ra:example<\/code><\/dd>/);

  const home = await page(siteRoot, 'index');
  assert.match(home, /## Conformance profiles/);
  assert.match(home, /\| \[Extension Y\]\(\/docs\/conformance-profiles\/extension-y\/\) \| `extension-y` \| Extension \| `core-profile`, `extension-x` \| Adds Y\. \|/);
  assert.doesNotMatch(home, /\| Extensions \|/);

  const functionality = await page(siteRoot, 'conformance-profiles/core-profile/functionalities/functionality-a');
  assert.match(functionality, /<dt>Conformance profile<\/dt><dd><a href="\/docs\/conformance-profiles\/core-profile\/">Core Profile<\/a> \(core\)<\/dd>/);
  assert.match(functionality, /<dt>Capabilities<\/dt><dd>Capability One<\/dd>/);
  assert.doesNotMatch(functionality, /<dt>Conformance<\/dt>/);
  assert.doesNotMatch(functionality, /Does A\.<br>/);

  assert.ok(manifest.warnings.includes('metadata.yml: extensions is ignored; conformance profiles are declared in the introduction.md of each profile folder'));
  assert.ok(manifest.warnings.some((warning) => warning.includes('functionality-a.md: conformance and extension are ignored')));
  assert.ok(manifest.warnings.includes('conformance-profiles/extension-y/introduction.md: does not link to its functionality conformance-profiles/extension-y/functionalities/functionality-y.md'));
});

test('options render beneath their variation point with conditions linked to their key view', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/' });
  assert.equal(manifest.requirementCount, 8);

  const output = await page(siteRoot, 'conformance-profiles/core-profile/functionalities/functionality-a');
  assert.match(output, /defines 3 requirements, and 3 options beneath its variation points\./);
  assert.doesNotMatch(output, /Unnumbered draft/);
  const variationPoint = output.slice(output.indexOf('<article class="requirement-card variation-point" id="requirement-1"'), output.indexOf('<article class="requirement-card requirement" id="requirement-2"'));
  assert.equal((variationPoint.match(/<article class="requirement-card option"/g) ?? []).length, 3);
  assert.match(variationPoint, /<dt>Selection<\/dt><dd>Meet at least 1 of its 3 options<\/dd>/);
  assert.match(variationPoint, /<dt>Verification<\/dt><dd>Counts the options that pass<\/dd>/);
  assert.match(variationPoint, /id="requirement-1-option-2"[\s\S]*<span class="requirement-draft-id">30\.2<\/span>/);
  assert.match(variationPoint, /<span>Level<\/span>OPTION/);
  assert.match(variationPoint, /href="\/conformance-profiles\/options-and-conditions\/#kind-one"><code class="requirement-key">kind-one<\/code>/);
  assert.match(variationPoint, /<dt>Met by claiming<\/dt><dd><a href="\/conformance-profiles\/extension-x\/">Extension X<\/a> extension<\/dd>/);
  assert.match(variationPoint, /<dt>Verification<\/dt><dd>By the extension&#39;s tests<\/dd>/);
  assert.match(variationPoint, /<dt>Presented by<\/dt><dd><a class="requirement-condition" href="\/conformance-profiles\/options-and-conditions\/#kind-one">/);
  assert.match(variationPoint, /href="\/resources\/tests\/kind-one\.feature"/);
  assert.match(output, /<dt>Applies when<\/dt><dd><a class="requirement-condition" href="\/conformance-profiles\/options-and-conditions\/#extension-y"><code>extension-y<\/code><\/a><\/dd>/);

  const view = await page(siteRoot, 'conformance-profiles/options-and-conditions');
  assert.match(view, /^### kind-one$/m);
  assert.match(view, /^### extension-y$/m);
  assert.match(view, /Option 30\.1 of the variation point <a href="\/conformance-profiles\/core-profile\/functionalities\/functionality-a\/#requirement-1">/);
  assert.match(view, /<a href="\/conformance-profiles\/core-profile\/functionalities\/functionality-a\/#requirement-2">The solution checks kind one before keeping it\.<\/a>/);
  assert.match(view, /### kind-two\n\n[\s\S]*?No requirement names it/);
  const generated = manifest.pages.find(({ route }) => route === 'conformance-profiles/options-and-conditions');
  assert.equal(generated.generated, true);
  assert.ok(generated.anchors.some(({ id }) => id === 'kind-x'));
  assert.equal(manifest.redirects.some(({ legacy }) => legacy.includes('options-and-conditions')), false);
});

test('verification follows from interaction, and observability is read only without one', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/' });
  const output = await page(siteRoot, 'conformance-profiles/core-profile/functionalities/functionality-a');
  assert.match(output, /<dt>Verification<\/dt><dd>Tested at the file boundary<\/dd>/);
  assert.match(output, /<dt>Verification<\/dt><dd>Audited against evidence<\/dd>/);
  assert.doesNotMatch(output, /<span>Observability<\/span>/);
  assert.ok(manifest.warnings.some((warning) => warning.includes('observability OBSERVABLE disagrees with interaction INTERNAL')));
  const unclassified = await page(siteRoot, 'conformance-profiles/extension-y/functionalities/functionality-y');
  assert.match(unclassified, /<dt>Verification<\/dt><dd>Unclassified<\/dd>/);
  assert.ok(manifest.warnings.some((warning) => warning.includes('requirement 50 has no interaction')));
});

test('profile rules that navigation and links depend on fail generation', async () => {
  const cases = [
    [{ 'conformance-profiles/extension-x/introduction.md': '---\ntitle: X\ntype: CORE\n---\n' }, /exactly one CORE conformance profile, found 2/],
    [{ 'conformance-profiles/extension-y/introduction.md': '---\ntitle: Y\ntype: EXTENSION\nrequires: [missing]\n---\n' }, /requires missing, which is not an extension profile/],
    [{ 'conformance-profiles/extension-x/introduction.md': '---\ntitle: X\ntype: EXTENSION\nrequires: [extension-y]\n---\n' }, /cycle: extension-x → extension-y → extension-x/],
    [{ 'conformance-profiles/core-profile/introduction.md': '---\ntitle: Core\ntype: CORE\nrequires: [extension-x]\n---\n' }, /the core never depends on an extension/],
    [{ 'conformance-profiles/extension-x/introduction.md': '---\ntitle: X\ntype: OPTIONAL\n---\n' }, /type must be CORE or EXTENSION/],
  ];
  for (const [files, error] of cases) {
    const { sourceRoot, siteRoot } = await fixture({ files });
    await assert.rejects(generateSite({ sourceRoot, siteRoot, base: '/' }), error);
  }
});

test('folder entries publish their files with an index, and a missing folder fails', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/docs/' });
  assert.deepEqual(manifest.sidebar.find(({ label }) => label === 'Resources').items, [{ label: 'tests/', link: '/resources/tests/' }]);
  assert.ok(manifest.supportIndexes.includes('resources/tests/index.html'));
  assert.match(await readFile(path.join(siteRoot, 'public/resources/tests/index.html'), 'utf8'), /kind-one\.feature/);

  const missing = await fixture({ toc: TOC.replace('    - tests/', '    - research/') });
  await assert.rejects(
    generateSite({ sourceRoot: missing.sourceRoot, siteRoot: missing.siteRoot, base: '/' }),
    /folder entry research\/ resolves to resources\/research\/, which is not a folder/,
  );
});

test('terminology.yml and references.yml render as pages without legacy redirects', async () => {
  const { sourceRoot, siteRoot } = await fixture();
  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/' });
  const terminology = await page(siteRoot, 'introduction/terminology');
  assert.match(terminology, /^title: Terminology$/m);
  assert.match(terminology, /^## Example Term \(ET\)$/m);
  assert.match(terminology, /A term used in examples\./);
  assert.match(terminology, /\*Note:\* A note to entry\./);
  assert.match(terminology, /Source: ISO 1234, 3\.1/);
  assert.ok(manifest.pages.find(({ source }) => source === 'introduction/terminology.yml').anchors.some(({ id }) => id === 'example-term-et'));
  const references = await page(siteRoot, 'introduction/references');
  assert.match(references, /- \[Example Standard\]\(<https:\/\/example\.invalid\/standard>\) \(2026\)/);
  assert.equal(manifest.redirects.some(({ legacy }) => legacy.endsWith('.yml')), false);
  await assert.rejects(access(path.join(siteRoot, 'public/introduction/terminology.yml')));
});

test('a specification without conformance profiles keeps its legacy layout', async () => {
  const { sourceRoot, siteRoot } = await fixture({
    toc: 'toc:\n  requirements:\n    - functionality.md\n',
    files: {
      'requirements/functionality.md': `---
title: Legacy
description: Legacy functionality.
conformance: EXTENSION
extension: audit
requirements:
  - id: '1'
    status: PUBLISHED
    level: REQUIRED
    observability: AUDITABLE
    statement: The solution is audited.
---
`,
    },
  });
  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/' });
  assert.deepEqual(manifest.profiles, []);
  const output = await page(siteRoot, 'requirements/functionality');
  assert.match(output, /<dt>Extension<\/dt><dd>audit<\/dd>/);
  assert.match(output, /<span>Observability<\/span>AUDITABLE/);
  assert.doesNotMatch(output, /<dt>Verification<\/dt>/);
  assert.match(await page(siteRoot, 'index'), /\| Extensions \| `stale` \|/);
  await rm(path.dirname(sourceRoot), { recursive: true, force: true });
});

test('root paths resolve against the specification root under the build base', async () => {
  const { sourceRoot, siteRoot } = await fixture({
    files: {
      'README.md': '# Example\n\n<figure><img src="/assets/cover.svg" alt="Cover"></figure>\n\n[Purpose](/introduction/purpose.md#purpose) and [tests](/resources/tests/).\n',
      'assets/cover.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      'assets/unreferenced.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    },
  });
  await generateSite({ sourceRoot, siteRoot, base: '/bb/example/' });
  const home = await page(siteRoot, 'index');
  assert.match(home, /src="\/bb\/example\/assets\/cover\.svg"/);
  assert.match(home, /\[Purpose\]\(\/bb\/example\/introduction\/purpose\/#purpose\)/);
  assert.match(home, /\[tests\]\(\/bb\/example\/resources\/tests\/\)/);
  await access(path.join(siteRoot, 'public/assets/cover.svg'));
  await assert.rejects(access(path.join(siteRoot, 'public/assets/unreferenced.svg')));

  const escaping = await fixture({ files: { 'README.md': '[Out](/../outside.md)\n' } });
  await assert.rejects(generateSite({ sourceRoot: escaping.sourceRoot, siteRoot: escaping.siteRoot, base: '/' }), /escapes the source root/);
});

test('decision records that a page links to are published under resources', async () => {
  const { sourceRoot, siteRoot } = await fixture({
    files: {
      'introduction/purpose.md': '# Purpose\n\nSee [the decision](../ADR/EXAMPLE-ADR-1.md#context).\n',
      'ADR/EXAMPLE-ADR-1.md': '---\ntitle: First decision\n---\n\n## Context\n\nFollows [the second](EXAMPLE-ADR-2.md).\n',
      'ADR/EXAMPLE-ADR-2.md': '# Second decision\n\nText.\n',
      'ADR/EXAMPLE-ADR-3.md': '# Unlinked decision\n',
    },
  });
  const manifest = await generateSite({ sourceRoot, siteRoot, base: '/' });
  assert.deepEqual(
    manifest.sidebar.find(({ label }) => label === 'Resources').items.slice(1),
    [
      { label: 'First decision', slug: 'adr/example-adr-1' },
      { label: 'Second decision', slug: 'adr/example-adr-2' },
    ],
  );
  assert.match(await page(siteRoot, 'introduction/purpose'), /\[the decision\]\(\/adr\/example-adr-1\/#context\)/);
  assert.equal(manifest.pages.some(({ source }) => source === 'ADR/EXAMPLE-ADR-3.md'), false);
  assert.ok(manifest.warnings.includes('ADR/EXAMPLE-ADR-2.md: not listed in toc.yml; published under resources because ADR/EXAMPLE-ADR-1.md links to it'));

  const other = await fixture({ files: { 'introduction/purpose.md': '[Notes](../notes/draft.md)\n', 'notes/draft.md': '# Draft\n' } });
  await assert.rejects(generateSite({ sourceRoot: other.sourceRoot, siteRoot: other.siteRoot, base: '/' }), /notes\/draft\.md is not listed in toc\.yml/);
});

test('a contract or test given as a URN or web URL is not turned into a local link', async () => {
  const { sourceRoot, siteRoot } = await fixture({
    files: {
      'conformance-profiles/extension-x/functionalities/functionality-x.md': `---
title: Functionality X
description: Does X.
requirements:
  - id: '40'
    status: PUBLISHED
    level: REQUIRED
    interaction: CONSUMED_API
    contract: "govstack:spec:bb:information-mediator"
    test: https://example.invalid/tests/40
    statement: The solution uses another Building Block.
---
`,
    },
  });
  await generateSite({ sourceRoot, siteRoot, base: '/bb/example/' });
  const output = await page(siteRoot, 'conformance-profiles/extension-x/functionalities/functionality-x');
  assert.match(output, /<dt>Contract<\/dt><dd><code>govstack:spec:bb:information-mediator<\/code><\/dd>/);
  assert.match(output, /<dt>Test<\/dt><dd><a href="https:\/\/example\.invalid\/tests\/40"><code>/);
});
