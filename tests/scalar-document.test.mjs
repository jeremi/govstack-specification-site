import assert from 'node:assert/strict';
import test from 'node:test';
import { getResolvedRef } from '@scalar/workspace-store/helpers/get-resolved-ref';
import { scalarDocument } from '../src/lib/scalar-document.mjs';

const fixture = () => ({
  openapi: '3.1.2',
  paths: {
    '/records': { get: { responses: {
      '400': { $ref: '#/components/responses/BadRequest', description: 'Invalid query parameters.' },
      '500': { $ref: '#/components/responses/BadRequest' },
    } } },
    '/search': { post: { responses: {
      '400': { $ref: '#/components/responses/BadRequest', description: 'Malformed JSON or invalid search input.' },
    } } },
  },
  components: { responses: { BadRequest: {
    description: 'Shared input error taxonomy.',
    headers: { 'Cache-Control': { schema: { const: 'no-store' } } },
    content: { 'application/problem+json': {
      schema: { $ref: '#/components/schemas/Problem' },
      example: { status: 400, description: { $ref: 'payload data', description: 'Keep this data.' } },
    } },
  } }, schemas: { Problem: { type: 'object', required: ['status'] } } },
});

test('Scalar receives each operation response description with the exact referenced content', () => {
  const source = fixture(), before = structuredClone(source);
  const rendered = scalarDocument(source);
  const response = getResolvedRef(rendered.paths['/records'].get.responses['400']);
  assert.equal(response.description, 'Invalid query parameters.');
  assert.deepEqual(response.content, source.components.responses.BadRequest.content);
  assert.deepEqual(response.headers, source.components.responses.BadRequest.headers);
  assert.equal(getResolvedRef(rendered.paths['/search'].post.responses['400']).description, 'Malformed JSON or invalid search input.');
  assert.deepEqual(rendered.components, source.components);
  assert.deepEqual(rendered.paths['/records'].get.responses['500'], source.paths['/records'].get.responses['500']);
  assert.deepEqual(source, before, 'the downloadable contract must not be mutated');
});

test('only OpenAPI 3.1 Reference descriptions are adapted', () => {
  const source = fixture();
  source.openapi = '3.0.3';
  assert.deepEqual(scalarDocument(source), source);
});

test('response aliases preserve inner descriptions and apply the outermost override', () => {
  const source = fixture();
  source.components.responses.Alias = { $ref: '#/components/responses/BadRequest', description: 'Alias description.' };
  source.paths['/records'].get.responses['400'].$ref = '#/components/responses/Alias';
  assert.equal(scalarDocument(source).paths['/records'].get.responses['400'].description, 'Invalid query parameters.');
});

test('missing or cyclic references fail visibly instead of displaying unrelated help', () => {
  const missing = fixture();
  missing.paths['/records'].get.responses['400'].$ref = '#/components/responses/Missing';
  assert.throws(() => scalarDocument(missing), /Missing.*reference/i);
  const cyclic = fixture();
  cyclic.components.responses.BadRequest = { $ref: '#/components/responses/BadRequest' };
  assert.throws(() => scalarDocument(cyclic), /Cyclic.*reference/i);
});
