import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBuild, normalizePublication, readPublication } from '../scripts/publication.mjs';

test('every profile requires an explicit source root', () => {
  assert.throws(() => resolveBuild({profile: 'framework'}), /explicit source/);
  assert.throws(() => resolveBuild({profile: 'api-guide'}), /explicit source/);
});

test('workspaces are keyed by profile and canonical source', () => {
  const a = resolveBuild({profile: 'framework', sourceRoot: '/private/tmp/source-a'});
  const again = resolveBuild({profile: 'framework', sourceRoot: '/private/tmp/source-a/'});
  const b = resolveBuild({profile: 'framework', sourceRoot: '/private/tmp/source-b'});
  assert.equal(a.workspace, again.workspace);
  assert.notEqual(a.workspace, b.workspace);
  assert.match(path.basename(a.workspace), /^framework-[0-9a-f]{12}$/);
  assert.equal(a.workspaceKey, path.basename(a.workspace));
});

test('the publication cannot be read without a workspace', () => {
  const previous = process.env.GOVSTACK_SITE_WORKSPACE;
  delete process.env.GOVSTACK_SITE_WORKSPACE;
  try { assert.throws(() => readPublication(), /GOVSTACK_SITE_WORKSPACE/); }
  finally { if (previous !== undefined) process.env.GOVSTACK_SITE_WORKSPACE = previous; }
});

test('profiles isolate generated workspaces and outputs', () => {
  const a = resolveBuild({profile: 'api-guide', sourceRoot: '/private/tmp/source-a'});
  const b = resolveBuild({profile: 'framework', sourceRoot: '/private/tmp/source-b'});
  assert.notEqual(a.workspace, b.workspace);
  assert.notEqual(a.distDir, b.distDir);
  assert.throws(() => resolveBuild({profile:'../../escape'}), /Unknown profile/);
  assert.throws(() => resolveBuild({profile:'api-guide', sourceRoot:path.dirname(a.workspace)}), /overlap/);
});

test('normalization preserves source identity, classifications, and input digest', () => {
  const raw = {version:'1.0.0-draft',sourceRevision:'abc123',sourceDigest:'sha256:abc',sourceDirty:true,pages:[{source:'README.md',route:'',title:'Existing candidate name',anchors:[{id:'stable'}]}],sidebar:[],tooling:{coverage:'partial'}};
  const publication = normalizePublication(raw, resolveBuild({profile:'api-guide',sourceRoot:'/private/tmp/source'}));
  assert.equal(publication.title, 'Existing candidate name');
  assert.equal(publication.sourceDigest, raw.sourceDigest);
  assert.deepEqual(publication.pages, raw.pages);
  assert.deepEqual(publication.tooling, raw.tooling);
  assert.equal(publication.publicationKind, null);
  assert.equal(publication.previewLabel, 'Local authoring preview');
  assert.deepEqual(publication.downloads, [{source:'rules.yaml',output:'downloads/rules.yaml',label:'Rule index'},{source:'linter/coverage.yaml',output:'downloads/linter/coverage.yaml',label:'Linter coverage'}]);
});

test('a symlinked output cannot bypass the canonical source overlap guard', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'govstack-output-guard-'));
  t.after(() => fs.rmSync(scratch, {recursive:true}));
  const source = path.join(scratch, 'source');
  fs.mkdirSync(source);
  fs.symlinkSync(source, path.join(scratch, 'output'));
  assert.throws(() => resolveBuild({profile:'api-guide',sourceRoot:source,distDir:path.join(scratch,'output')}), /overlap/);
  assert.throws(() => resolveBuild({profile:'api-guide',sourceRoot:source,distDir:path.join(scratch,'output','nested')}), /overlap/);
});
