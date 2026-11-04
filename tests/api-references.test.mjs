import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { generateSite } from '../adapters/framework.mjs';
import { apiReferenceMarkup, prepareApiReferences } from '../scripts/api-references.mjs';

const execFileAsync = promisify(execFile);

async function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

const contract = `openapi: 3.1.2
info:
  title: Registry fixture
  version: 1.0.0
paths:
  /v1/records/{recordId}:
    get:
      operationId: retrieveRecord
      summary: Retrieve a record
      x-govstack-digital-registries:
        capability: retrieve
        purpose:
          required: true
          allowedPurposes: [benefit-eligibility]
      responses:
        '200':
          description: The actual published record response.
          content:
            application/json:
              schema:
                $ref: './common/record.schema.json#/$defs/Record'
              examples:
                published:
                  summary: Published 200 response
                  value:
                    recordId: record_19
                    data:
                      status: ACTIVE
  /v1/records/search:
    post:
      operationId: searchRecords
      summary: Search records
      responses:
        '200':
          description: A published search page.
          content:
            application/json:
              schema:
                type: object
                required: [items]
                properties:
                  items:
                    type: array
                    items:
                      $ref: './common/record.schema.json#/$defs/Record'
                example:
                  items:
                    - recordId: record_20
                      data:
                        status: PENDING
`;

const commonSchema = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "Record": {
      "type": "object",
      "description": "The normative record envelope remains unchanged.",
      "required": ["recordId", "data"],
      "properties": {
        "recordId": { "type": "string", "minLength": 1 },
        "data": {
          "type": "object",
          "additionalProperties": true,
          "properties": { "status": { "$dynamicRef": "./status.schema.json#status" } }
        }
      },
      "x-source-metadata": { "authority": "fixture" }
    }
  }
}
`;

const statusSchema = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$dynamicAnchor": "status",
  "type": "string"
}
`;

const genericContract = `openapi: 3.1.2
info:
  title: Another building block fixture
  version: 2.0.0
servers:
  - url: /another-block/v2
security:
  - bearerAuth: []
paths:
  /widgets:
    get:
      summary: List widgets
      x-another-block:
        capability: list-widgets
        audience: institutions
      x-other: false
      responses:
        '200':
          description: Widget list
          content:
            application/json:
              schema:
                $ref: './widget.schema.json'
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`;

const genericSchema = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["id"],
    "properties": { "id": { "type": "string" } }
  }
}
`;

function config(references = [
  {
    id: 'record-retrieve',
    page: 'core.md',
    contract: 'api/openapi.yaml',
    role: 'normative',
    operationId: 'retrieveRecord',
    response: '200',
    example: 'published',
  },
  {
    id: 'record-search',
    page: 'examples/search.md',
    contract: 'api/openapi.yaml',
    role: 'example',
    operationId: 'searchRecords',
    response: '200',
  },
]) {
  const lines = ['references:'];
  for (const reference of references) {
    lines.push(`  - id: ${reference.id}`);
    lines.push(`    page: ${reference.page}`);
    lines.push(`    contract: ${reference.contract}`);
    lines.push(`    role: ${reference.role}`);
    if (reference.operationId !== undefined) lines.push(`    operationId: ${reference.operationId}`);
    if (reference.response !== undefined) lines.push(`    response: '${reference.response}'`);
    if (reference.example) lines.push(`    example: ${reference.example}`);
    if (reference.futureOption !== undefined) lines.push(`    futureOption: ${reference.futureOption}`);
  }
  return `${lines.join('\n')}\n`;
}

async function fixture(t, references) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'govstack-api-references-'));
  t.after(() => rm(root, { recursive: true }));
  const sourceRoot = path.join(root, 'source');
  const siteRoot = path.join(root, 'site');
  await write(sourceRoot, 'api-references.yml', config(references));
  await write(sourceRoot, 'api/openapi.yaml', contract);
  await write(sourceRoot, 'api/common/record.schema.json', commonSchema);
  await write(sourceRoot, 'api/common/status.schema.json', statusSchema);
  return { root, sourceRoot, siteRoot };
}

async function sourceBytes(sourceRoot) {
  return new Map(
    await Promise.all(
      [
        'api-references.yml',
        'api/openapi.yaml',
        'api/common/record.schema.json',
        'api/common/status.schema.json',
      ].map(
        async (relative) => [relative, await readFile(path.join(sourceRoot, relative))],
      ),
    ),
  );
}

async function assertSourceUnchanged(sourceRoot, before) {
  for (const [relative, bytes] of before) {
    assert.equal(
      (await readFile(path.join(sourceRoot, relative))).compare(bytes),
      0,
      `${relative} authoring bytes changed`,
    );
  }
}

test('absent configuration is a no-op', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'govstack-api-references-absent-'));
  t.after(() => rm(root, { recursive: true }));
  const sourceRoot = path.join(root, 'source');
  const siteRoot = path.join(root, 'site');
  await mkdir(sourceRoot);
  await write(siteRoot, 'keep.txt', 'unchanged');
  const snapshots = new Map([['existing', Buffer.from('snapshot')]]);

  assert.deepEqual(
    await prepareApiReferences({ sourceRoot, siteRoot, snapshots }),
    { references: [], supportFiles: [] },
  );
  assert.equal(await readFile(path.join(siteRoot, 'keep.txt'), 'utf8'), 'unchanged');
  assert.deepEqual([...snapshots], [['existing', Buffer.from('snapshot')]]);
  assert.deepEqual(await readdir(siteRoot), ['keep.txt']);
});

test('prepares labelled references from exact published 200 examples', async (t) => {
  const { sourceRoot, siteRoot } = await fixture(t);
  const before = await sourceBytes(sourceRoot);
  const snapshots = new Map();

  const { references, supportFiles } = await prepareApiReferences({
    sourceRoot,
    siteRoot,
    base: '/standards/digital-registries/',
    snapshots,
  });

  assert.equal(references.length, 2);
  assert.equal(references[0].role, 'normative');
  assert.match(references[0].label, /normative/i);
  assert.equal(references[1].role, 'example');
  assert.match(references[1].label, /example/i);
  assert.equal(
    references[0].contractUrl,
    '/standards/digital-registries/api-reference/record-retrieve.json',
  );
  assert.deepEqual(references[0].example.value, {
    recordId: 'record_19',
    data: { status: 'ACTIVE' },
  });
  assert.deepEqual(references[1].example.value, {
    items: [{ recordId: 'record_20', data: { status: 'PENDING' } }],
  });
  assert.deepEqual(
    references[0].metadata.operations.map(({ method, path: operationPath, operationId }) => ({
      method,
      path: operationPath,
      operationId,
    })),
    [
      { method: 'get', path: '/v1/records/{recordId}', operationId: 'retrieveRecord' },
      { method: 'post', path: '/v1/records/search', operationId: 'searchRecords' },
    ],
  );
  assert.ok(supportFiles.some((file) => /(^|\/)scalar[^/]*\.js$/.test(file)), 'local Scalar asset');
  assert.ok(supportFiles.includes('api-reference/record-retrieve.json'));
  assert.ok(supportFiles.includes('api-reference/record-search.json'));
  assert.ok(supportFiles.includes('api/openapi.yaml'), 'declared source contract download');
  assert.ok(supportFiles.includes('api/common/record.schema.json'), 'source contract dependency download');
  assert.ok(supportFiles.includes('api/common/status.schema.json'), 'dynamic source dependency download');
  assert.equal(supportFiles.some((file) => file.endsWith('.html')), false);
  assert.equal(references[0].viewerUrl, undefined);
  assert.equal(references[1].viewerUrl, undefined);
  for (const relative of [
    'api-references.yml',
    'api/openapi.yaml',
    'api/common/record.schema.json',
    'api/common/status.schema.json',
  ]) {
    assert.ok(snapshots.has(relative), `${relative} must contribute to source snapshots`);
  }
  assert.equal(
    (await readFile(path.join(siteRoot, 'public/api/openapi.yaml'))).compare(before.get('api/openapi.yaml')),
    0,
    'source contract download must preserve authoring bytes',
  );
  assert.equal(
    (await readFile(path.join(siteRoot, 'public/api/common/record.schema.json'))).compare(
      before.get('api/common/record.schema.json'),
    ),
    0,
    'source dependency download must preserve authoring bytes',
  );
  assert.equal(
    (await readFile(path.join(siteRoot, 'public/api/common/status.schema.json'))).compare(
      before.get('api/common/status.schema.json'),
    ),
    0,
    'dynamic source dependency download must preserve authoring bytes',
  );
  await assertSourceUnchanged(sourceRoot, before);
});

test('prepares a generic OpenAPI reference without an operation selection or examples', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'govstack-api-references-generic-'));
  t.after(() => rm(root, { recursive: true }));
  const sourceRoot = path.join(root, 'source');
  const siteRoot = path.join(root, 'site');
  await write(sourceRoot, 'api-references.yml', config([{
    id: 'another-block',
    page: 'reference.md',
    contract: 'api/openapi.yaml',
    role: 'normative',
  }]));
  await write(sourceRoot, 'api/openapi.yaml', genericContract);
  await write(sourceRoot, 'api/widget.schema.json', genericSchema);
  const sourcePaths = ['api-references.yml', 'api/openapi.yaml', 'api/widget.schema.json'];
  const before = new Map(await Promise.all(sourcePaths.map(async (relative) => [
    relative,
    await readFile(path.join(sourceRoot, relative)),
  ])));

  const { references } = await prepareApiReferences({
    sourceRoot,
    siteRoot,
    base: '/standards/another-block/',
  });
  const output = JSON.parse(
    await readFile(path.join(siteRoot, 'public/api-reference/another-block.json'), 'utf8'),
  );

  assert.equal(references[0].contractUrl, '/standards/another-block/api-reference/another-block.json');
  assert.equal(references[0].example, undefined);
  assert.deepEqual(references[0].metadata.operations, [{
    method: 'get',
    path: '/widgets',
    operationId: undefined,
    'x-another-block': { capability: 'list-widgets', audience: 'institutions' },
    'x-other': false,
  }]);
  assert.deepEqual(output.servers, [{ url: '/another-block/v2' }]);
  assert.deepEqual(output.security, [{ bearerAuth: [] }]);
  assert.deepEqual(output.components.securitySchemes.bearerAuth, {
    type: 'http',
    scheme: 'bearer',
  });
  assert.ok(
    output.paths['/widgets'].get.responses['200'].content['application/json'].schema.$ref
      .startsWith('#/'),
    'the bundled external schema remains an internal reference',
  );
  for (const [relative, bytes] of before) {
    assert.equal(
      (await readFile(path.join(sourceRoot, relative))).compare(bytes),
      0,
      `${relative} authoring bytes changed`,
    );
  }
});

test('bundles only internal refs while preserving examples, extensions and schema claims', async (t) => {
  const { sourceRoot, siteRoot } = await fixture(t);
  const before = await sourceBytes(sourceRoot);
  const { references } = await prepareApiReferences({ sourceRoot, siteRoot });
  const output = JSON.parse(
    await readFile(path.join(siteRoot, 'public/api-reference/record-retrieve.json'), 'utf8'),
  );
  const refs = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if ('$ref' in value) refs.push(value.$ref);
    for (const child of Object.values(value)) visit(child);
  };
  visit(output);

  assert.ok(refs.length > 0);
  assert.ok(refs.every((value) => value.startsWith('#/')), refs.join('\n'));
  assert.deepEqual(
    output.paths['/v1/records/{recordId}'].get.responses['200'].content['application/json']
      .examples.published,
    {
      summary: 'Published 200 response',
      value: { recordId: 'record_19', data: { status: 'ACTIVE' } },
    },
  );
  assert.deepEqual(
    output.paths['/v1/records/{recordId}'].get['x-govstack-digital-registries'],
    {
      capability: 'retrieve',
      purpose: { required: true, allowedPurposes: ['benefit-eligibility'] },
    },
  );
  const bundledRecord = Object.values(output.components.schemas).find(
    (schema) => schema.description === 'The normative record envelope remains unchanged.',
  );
  assert.equal(bundledRecord.properties.recordId.minLength, 1);
  assert.deepEqual(bundledRecord['x-source-metadata'], { authority: 'fixture' });
  assert.equal(references[0].example.value.recordId, 'record_19');
  await assertSourceUnchanged(sourceRoot, before);
});

test('rejects reserved output collisions before overwriting source support files', async (t) => {
  const cases = [
    'api-reference/record-retrieve.json',
    'api-reference/scalar-1.76.4.js',
    'api-reference/record-retrieve.json/owned.txt',
  ];
  for (const reserved of cases) {
    await t.test(reserved, async (t) => {
      const { sourceRoot, siteRoot } = await fixture(t);
      const sentinel = 'source-owned support file';
      await write(siteRoot, `public/${reserved}`, sentinel);

      await assert.rejects(
        prepareApiReferences({ sourceRoot, siteRoot, reservedPaths: [reserved] }),
        /generated API reference output collides with source support file/i,
      );
      assert.equal(await readFile(path.join(siteRoot, 'public', reserved), 'utf8'), sentinel);
      await assert.rejects(access(path.join(siteRoot, 'api-reference-bundler.yml')));
      if (reserved !== 'api-reference/scalar-1.76.4.js') {
        await assert.rejects(
          access(path.join(siteRoot, 'public/api-reference/scalar-1.76.4.js')),
        );
      }
    });
  }
});

test('markup uses an empty native Scalar host with links and closed metadata only', async (t) => {
  const { sourceRoot, siteRoot } = await fixture(t);
  const { references } = await prepareApiReferences({
    sourceRoot,
    siteRoot,
    base: '/preview/',
  });
  const markup = apiReferenceMarkup(references[0]);

  assert.match(markup, /Normative/i);
  assert.match(markup, /<details(?:\s|>)/i);
  assert.doesNotMatch(markup, /<details[^>]*\sopen(?:\s|>)/i);
  assert.match(markup, /retrieveRecord/);
  assert.match(markup, /Source OpenAPI/i);
  assert.match(markup, /Download OpenAPI/i);
  assert.match(markup, /<div[^>]*\bdata-scalar-reference(?:=(?:""|''))?[^>]*>\s*<\/div>/i);
  assert.match(markup, /data-contract-url="\/preview\/api-reference\/record-retrieve\.json"/);
  assert.match(markup, /data-script-url="\/preview\/api-reference\/scalar[^/"']*\.js"/);
  assert.doesNotMatch(markup, /<iframe\b/i);
  assert.doesNotMatch(markup, /<figure\b/i);
  assert.doesNotMatch(markup, /record_19|ACTIVE/);
  assert.doesNotMatch(markup, /api-reference-scope|transport rules|example response values/i);
});

test('root and nested deployment bases produce correct contract and asset URLs', async (t) => {
  for (const [base, expected] of [
    ['/', '/api-reference/record-retrieve.json'],
    ['/nested/site/', '/nested/site/api-reference/record-retrieve.json'],
  ]) {
    const { sourceRoot, siteRoot } = await fixture(t);
    const { references } = await prepareApiReferences({ sourceRoot, siteRoot, base });
    assert.equal(references[0].contractUrl, expected);
    const markup = apiReferenceMarkup(references[0]);
    assert.match(markup, new RegExp(`data-contract-url="${expected.replaceAll('/', '\\/')}"`));
    assert.match(
      markup,
      new RegExp(`data-script-url="${base === '/' ? '' : base.slice(0, -1).replaceAll('/', '\\/')}\\/api-reference\\/scalar[^"']*\\.js"`),
    );
  }
});

test('rejects incomplete selections, unknown operations and unknown named examples', async (t) => {
  const cases = [
    ['response without operationId', { operationId: undefined }, /operationId/i],
    ['operationId without response', { response: undefined }, /response/i],
    ['example without a selection', { operationId: undefined, response: undefined }, /example|operationId|response/i],
    ['unknown operationId', { operationId: 'doesNotExist' }, /doesNotExist|operation/i],
    ['unknown response status', { response: '201' }, /selected response|201|representation/i],
    ['unsuccessful response status', { response: '400' }, /successful.*status/i],
    ['unknown named example', { example: 'invented' }, /invented|example/i],
  ];
  for (const [name, overrides, expected] of cases) {
    await t.test(name, async (t) => {
      const reference = {
        id: 'record-retrieve',
        page: 'core.md',
        contract: 'api/openapi.yaml',
        role: 'normative',
        operationId: 'retrieveRecord',
        response: '200',
        example: 'published',
        ...overrides,
      };
      const { sourceRoot, siteRoot } = await fixture(t, [reference]);
      await assert.rejects(prepareApiReferences({ sourceRoot, siteRoot }), expected);
    });
  }
});

test('rejects ambiguous identifiers and unsafe or future configuration', async (t) => {
  const original = {
    id: 'record-retrieve',
    page: 'core.md',
    contract: 'api/openapi.yaml',
    role: 'normative',
    operationId: 'retrieveRecord',
    response: '200',
    example: 'published',
  };
  const cases = [
    ['duplicate id', [original, { ...original, page: 'other.md' }], /duplicate.*id/i],
    ['duplicate page', [original, { ...original, id: 'other' }], /duplicate.*page/i],
    ['unknown role', [{ ...original, role: 'future-role' }], /role/i],
    ['contract traversal', [{ ...original, contract: '../outside.yaml' }], /contract|path|travers/i],
    ['page traversal', [{ ...original, page: '../outside.md' }], /page|path|travers/i],
    ['unknown configuration', [{ ...original, futureOption: true }], /unknown.*configuration/i],
  ];
  for (const [name, references, expected] of cases) {
    await t.test(name, async (t) => {
      const { sourceRoot, siteRoot } = await fixture(t, references);
      await assert.rejects(prepareApiReferences({ sourceRoot, siteRoot }), expected);
    });
  }
});

test('rejects source escapes and remote refs before attempting a fetch', async (t) => {
  await t.test('outside-source symlink', async (t) => {
    const { root, sourceRoot, siteRoot } = await fixture(t);
    const outside = path.join(root, 'outside.yaml');
    await writeFile(outside, contract);
    await rm(path.join(sourceRoot, 'api/openapi.yaml'));
    await symlink(outside, path.join(sourceRoot, 'api/openapi.yaml'));
    await assert.rejects(
      prepareApiReferences({ sourceRoot, siteRoot }),
      /symlink|outside|escape|source/i,
    );
  });

  await t.test('HTTP ref', async (t) => {
    const { sourceRoot, siteRoot } = await fixture(t);
    const remoteContract = contract.replace(
      './common/record.schema.json#/$defs/Record',
      'https://schemas.example.invalid/record.json#/$defs/Record',
    );
    await writeFile(path.join(sourceRoot, 'api/openapi.yaml'), remoteContract);
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error('network access attempted');
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    await assert.rejects(
      prepareApiReferences({ sourceRoot, siteRoot }),
      /remote|http|network|ref/i,
    );
    assert.equal(fetches, 0);
    await assert.rejects(access(path.join(siteRoot, 'public/api-reference/record-retrieve.json')));
  });
});

test('framework opt-in classifies API pages without changing source or generic navigation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'govstack-api-reference-framework-'));
  t.after(() => rm(root, { recursive: true }));
  const sourceRoot = path.join(root, 'source');
  const siteRoot = path.join(root, 'site');
  const references = [
    {
      id: 'record-retrieve',
      page: 'contracts/core.md',
      contract: 'api/openapi.yaml',
      role: 'normative',
      operationId: 'retrieveRecord',
      response: '200',
      example: 'published',
    },
    {
      id: 'record-search',
      page: 'examples/search.md',
      contract: 'api/openapi.yaml',
      role: 'example',
      operationId: 'searchRecords',
      response: '200',
    },
  ];
  await write(sourceRoot, 'toc.yml', `toc:
  contracts:
    - core.md
  examples:
    - search.md
  resources:
    - guide.md
`);
  await write(sourceRoot, 'metadata.yml', `name: Registry fixture
abstract: A renderer integration fixture.
url: https://example.invalid/registries/
repository: https://github.com/example/registries
urn: govstack:spec:bb:registries
owner_group: govstack:wg:registries
capabilities: []
extensions: []
versions:
  - version: 1.0.0-draft
    release_date:
    short_description: Fixture draft.
    latest: true
`);
  await write(sourceRoot, 'authors.yml', `authors:
  - name: Example Author
    roles: [Author]
    urn: govstack:person:example
`);
  await write(sourceRoot, 'README.md', '# Registry fixture\n\nGeneric introduction.\n');
  await write(sourceRoot, 'contracts/core.md', '# Core contract\n\nNormative source prose.\n');
  await write(sourceRoot, 'examples/search.md', '# Search example\n\nIllustrative source prose.\n');
  await write(sourceRoot, 'resources/guide.md', '# Reader guide\n\nGeneric guidance.\n');
  await write(sourceRoot, 'api-references.yml', config(references));
  await write(sourceRoot, 'api/openapi.yaml', contract);
  await write(sourceRoot, 'api/common/record.schema.json', commonSchema);
  await write(sourceRoot, 'api/common/status.schema.json', statusSchema);
  await execFileAsync('git', ['init', '-q', sourceRoot]);
  await execFileAsync('git', ['-C', sourceRoot, 'add', '.']);
  await execFileAsync('git', [
    '-C', sourceRoot,
    '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture',
  ]);

  const authoringPaths = [
    'toc.yml',
    'metadata.yml',
    'authors.yml',
    'README.md',
    'contracts/core.md',
    'examples/search.md',
    'resources/guide.md',
    'api-references.yml',
    'api/openapi.yaml',
    'api/common/record.schema.json',
    'api/common/status.schema.json',
  ];
  const before = new Map(
    await Promise.all(
      authoringPaths.map(async (relative) => [relative, await readFile(path.join(sourceRoot, relative))]),
    ),
  );
  const manifest = await generateSite({
    sourceRoot,
    siteRoot,
    base: '/standards/registries/',
    unofficial: true,
  });

  const apiGroup = manifest.sidebar.find((entry) => entry.label === 'API reference');
  assert.deepEqual(apiGroup.items.map(({ label }) => label), [
    'Normative draft',
    'Illustrative examples',
  ]);
  assert.deepEqual(apiGroup.items[0].items, [{ label: 'Core contract', slug: 'contracts/core' }]);
  assert.deepEqual(apiGroup.items[1].items, [{ label: 'Search example', slug: 'examples/search' }]);
  assert.ok(
    manifest.sidebar.some(
      (entry) => entry.label === 'Resources'
        && entry.items.some((item) => item.slug === 'resources/guide'),
    ),
    'generic navigation remains present',
  );
  assert.equal(manifest.apiReferences.length, 2);
  for (const relative of [
    'api/openapi.yaml',
    'api/common/record.schema.json',
    'api/common/status.schema.json',
  ]) {
    assert.equal(manifest.supportFiles.includes(relative), true, `${relative} source download`);
    assert.equal(
      (await readFile(path.join(siteRoot, 'public', relative))).compare(before.get(relative)),
      0,
      `${relative} published bytes`,
    );
  }
  assert.equal(manifest.supportFiles.includes('api-references.yml'), false);
  const corePage = await readFile(
    path.join(siteRoot, 'src/content/docs/contracts/core.md'),
    'utf8',
  );
  const guidePage = await readFile(
    path.join(siteRoot, 'src/content/docs/resources/guide.md'),
    'utf8',
  );
  assert.match(corePage, /data-api-reference-role="normative"/);
  assert.match(corePage, /^tableOfContents: false$/m);
  assert.match(corePage, /^prev: false$/m);
  assert.match(corePage, /^next: false$/m);
  assert.match(corePage, /<a id="core-contract"><\/a>/);
  assert.match(corePage, /data-scalar-reference/);
  assert.match(
    corePage,
    /data-contract-url="\/standards\/registries\/api-reference\/record-retrieve\.json"/,
  );
  assert.match(corePage, /data-script-url="\/standards\/registries\/api-reference\/scalar[^"']*\.js"/);
  assert.doesNotMatch(corePage, /Normative source prose/);
  assert.doesNotMatch(corePage, /<iframe\b|<figure\b/);
  assert.doesNotMatch(guidePage, /data-api-reference-role/);
  assert.match(guidePage, /Generic guidance/);
  assert.doesNotMatch(guidePage, /^tableOfContents: false$/m);
  assert.doesNotMatch(guidePage, /^prev: false$/m);
  assert.doesNotMatch(guidePage, /^next: false$/m);
  assert.equal(manifest.supportFiles.some((file) => file.endsWith('.html')), false);
  await assert.rejects(access(path.join(siteRoot, 'public/api-reference/record-retrieve.html')));
  for (const [relative, bytes] of before) {
    assert.equal(
      (await readFile(path.join(sourceRoot, relative))).compare(bytes),
      0,
      `${relative} changed during framework generation`,
    );
  }
});
