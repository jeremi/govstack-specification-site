import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apiReferenceMarkup, prepareApiReferences } from '../scripts/api-references.mjs';

test('native reference uses Scalar introduction without a repeated hand-built introduction or response', async () => {
  const reference = {
    id: 'birth', title: 'Birth registration', role: 'example',
    contract: 'api/birth.yaml', contractUrl: '/registries/api-reference/birth.json',
    scriptUrl: '/registries/api-reference/scalar.js',
    example: { operationId: 'retrieveBirthRegistration', status: '200', value: { recordId: 'birth_19', data: { name: '<img src=x onerror=alert(1)>' } } },
    metadata: [{ operationId: 'retrieveBirthRegistration', method: 'GET', path: '/records/{recordId}', context: { capability: '<img src=x onerror=alert(1)>' } }],
  };
  const html = apiReferenceMarkup(reference);
  assert.match(html, /Illustrative example/);
  assert.match(html, /does not add requirements/i);
  assert.doesNotMatch(html, /birth_19|api-response-example|api-reference-intro/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /<details[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
  assert.doesNotMatch(html, /<iframe|birth\.html/);
  assert.match(html, /data-scalar-reference/);
  assert.match(html, /data-script-url="\/registries\/api-reference\/scalar\.js"/);
  assert.match(html, /\/registries\/api-reference\/birth\.json/);

  const styles = await readFile(new URL('../src/styles/govstack.css', import.meta.url), 'utf8');
  assert.doesNotMatch(
    styles,
    /\[id\$=['"]\/description\/introduction['"]\][^{]*\{[^}]*\bdisplay\s*:\s*none\b/i,
    "Scalar's info.description introduction must remain visible",
  );
});

test('native reference markup does not require an operation or response selection', () => {
  const html = apiReferenceMarkup({
    id: 'payments',
    role: 'normative',
    contractUrl: '/payments/api-reference/payments.json',
    scriptUrl: '/payments/api-reference/scalar.js',
    metadata: {
      openapi: '3.1.2',
      operations: [{
        method: 'post',
        path: '/transfers',
        operationId: undefined,
        'x-payments': { capability: 'transfer' },
      }],
    },
  });

  assert.match(html, /data-scalar-reference/);
  assert.match(html, /\/payments\/api-reference\/payments\.json/);
  assert.match(html, /&quot;x-payments&quot;/);
  assert.doesNotMatch(html, /api-response-example|operation selection/i);
});

test('native Scalar sticky content clears the Starlight header', async () => {
  const styles = await readFile(new URL('../src/styles/govstack.css', import.meta.url), 'utf8');
  assert.match(
    styles,
    /\[data-scalar-reference\]\s*\{[^}]*--scalar-custom-header-height\s*:\s*var\(--sl-nav-height\)/i,
    'Scalar must include the fixed Starlight header in its viewport offset',
  );
});

test('absolute contract refs cannot use an in-source decoy to read outside the source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'api-reference-absolute-'));
  t.after(() => rm(root, { recursive: true }));
  const sourceRoot = path.join(root, 'source');
  const outside = path.join(root, 'outside.json');
  const decoy = path.join(sourceRoot, path.posix.join('api', outside));
  await mkdir(path.dirname(decoy), { recursive: true });
  await writeFile(outside, JSON.stringify({ type: 'object', example: { escaped: true } }));
  await writeFile(decoy, JSON.stringify({ type: 'object', example: { escaped: false } }));
  await writeFile(path.join(sourceRoot, 'api-references.yml'), `references:\n  - id: sample\n    page: sample.md\n    contract: api/openapi.yaml\n    role: example\n    operationId: retrieve\n    response: '200'\n`);
  const contract = {
    openapi: '3.1.2', info: { title: 'Fixture', version: '1' },
    paths: { '/records': { get: { operationId: 'retrieve', responses: { '200': {
      description: 'Fixture', content: { 'application/json': { schema: { $ref: outside } } },
    } } } } },
  };
  for (const ref of [outside, encodeURIComponent(outside)]) {
    contract.paths['/records'].get.responses['200'].content['application/json'].schema.$ref = ref;
    await writeFile(path.join(sourceRoot, 'api/openapi.yaml'), JSON.stringify(contract));
    await assert.rejects(prepareApiReferences({ sourceRoot, siteRoot: path.join(root, 'site') }), /absolute|outside|escape/i);
  }
});
