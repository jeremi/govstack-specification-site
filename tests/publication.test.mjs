import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBuild, normalizePublication, readPublication, robotsContent, sourceLinks, writeCrawlerPolicy } from '../scripts/publication.mjs';
import { buildOptions, parseCli } from '../scripts/site.mjs';

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

test('official builds are the default and unofficial builds are explicit', () => {
  const official = resolveBuild({profile:'api-guide',sourceRoot:'/private/tmp/source'});
  const unofficial = resolveBuild({profile:'api-guide',sourceRoot:'/private/tmp/source',unofficial:true});
  assert.equal(official.unofficial, false);
  assert.equal(unofficial.unofficial, true);
  assert.equal(normalizePublication({version:'1',pages:[{route:'',title:'T'}]}, official).unofficial, false);
  assert.equal(normalizePublication({version:'1',pages:[{route:'',title:'T'}]}, official).previewLabel, 'Local authoring preview');
});

test('the publication records the unofficial flag and labels the preview', () => {
  const publication = normalizePublication({version:'1',pages:[{route:'',title:'T'}]}, resolveBuild({profile:'api-guide',sourceRoot:'/private/tmp/source',unofficial:true}));
  assert.equal(publication.unofficial, true);
  assert.equal(publication.previewLabel, 'Unofficial preview');
});

test('robots content is one value per mode', () => {
  assert.equal(robotsContent(false), 'noindex, follow');
  assert.equal(robotsContent(true), 'noindex, nofollow');
});

test('crawler policy file is written only for unofficial builds', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'govstack-robots-'));
  t.after(() => fs.rmSync(scratch, {recursive:true}));
  await writeCrawlerPolicy(scratch, false);
  assert.equal(fs.existsSync(path.join(scratch, 'public/robots.txt')), false);
  await writeCrawlerPolicy(scratch, true);
  assert.equal(fs.readFileSync(path.join(scratch, 'public/robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
});

test('source URLs derive blob and edit roots and are validated', () => {
  assert.deepEqual(sourceLinks('https://github.com/jeremi/govstack-api-design-guide/blob/main/'), {
    blobRoot: 'https://github.com/jeremi/govstack-api-design-guide/blob/main',
    editRoot: 'https://github.com/jeremi/govstack-api-design-guide/edit/main',
  });
  assert.deepEqual(sourceLinks(), {
    blobRoot: 'https://github.com/GovStackWorkingGroup/bb-template/blob/main/api-design-guide',
    editRoot: 'https://github.com/GovStackWorkingGroup/bb-template/edit/main/api-design-guide',
  });
  for (const bad of ['http://github.com/o/r/blob/main', 'https://github.com/o/r/blob/main?x=1', 'https://github.com/o/r/blob/main#frag', 'github.com/o/r/blob/main', 'https://github.com/o/r/tree/main']) {
    assert.throws(() => sourceLinks(bad), /source URL/i, bad);
  }
});

test('resolveBuild carries a normalized source URL for the api-guide profile only', () => {
  const build = resolveBuild({profile:'api-guide',sourceRoot:'/private/tmp/source',sourceUrl:'https://github.com/o/r/blob/main/'});
  assert.equal(build.sourceUrl, 'https://github.com/o/r/blob/main');
  assert.equal(resolveBuild({profile:'api-guide',sourceRoot:'/private/tmp/source'}).sourceUrl, undefined);
  assert.throws(() => resolveBuild({profile:'api-guide',sourceRoot:'/private/tmp/source',sourceUrl:'ftp://x/blob/y'}), /source URL/i);
  assert.throws(() => resolveBuild({profile:'framework',sourceRoot:'/private/tmp/source',sourceUrl:'https://github.com/o/r/blob/main'}), /api-guide/);
});

test('command line options fall back to DOCS_* environment variables', () => {
  assert.deepEqual(buildOptions({}, {}), {profile:'api-guide',sourceRoot:undefined,distDir:undefined,base:'/',unofficial:false,sourceUrl:undefined});
  const fromEnv = buildOptions({}, {DOCS_PROFILE:'framework',DOCS_SOURCE_ROOT:'/s',DOCS_DIST_DIR:'/d',DOCS_BASE:'/b/',DOCS_UNOFFICIAL:'1',DOCS_SOURCE_URL:'https://github.com/o/r/blob/main'});
  assert.deepEqual(fromEnv, {profile:'framework',sourceRoot:'/s',distDir:'/d',base:'/b/',unofficial:true,sourceUrl:'https://github.com/o/r/blob/main'});
  assert.equal(buildOptions({unofficial:true}, {}).unofficial, true);
  assert.equal(buildOptions({}, {DOCS_UNOFFICIAL:'0'}).unofficial, false);
  assert.equal(buildOptions({}, {DOCS_UNOFFICIAL:''}).unofficial, false);
  assert.equal(buildOptions({'source-url':'https://a/blob/b'}, {DOCS_SOURCE_URL:'https://c/blob/d'}).sourceUrl, 'https://a/blob/b');
});

test('the command line parses --unofficial and --source-url', () => {
  const { values } = parseCli(['check', '--unofficial', '--source-url', 'https://github.com/o/r/blob/main']);
  assert.equal(values.unofficial, true);
  assert.equal(values['source-url'], 'https://github.com/o/r/blob/main');
  assert.equal(parseCli(['check']).values.unofficial, undefined);
});
