import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { landingHtml, parseList } from '../scripts/publish.mjs';

test('the published Building Block list is valid', async () => {
  const list = await readFile(path.resolve(import.meta.dirname, '../publish/building-blocks.yml'), 'utf8');
  const entries = parseList(list);
  assert.ok(entries.length > 0);
  assert.ok(entries.some(({ id }) => id === 'wallet'));
});

test('the Building Block list rejects entries that would publish ambiguously or unsafely', () => {
  const entry = (fields) => `building_blocks:\n  - ${Object.entries({ id: 'wallet', title: 'Wallet', repository: 'org/bb-wallet', ref: 'main', ...fields }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n    ')}\n`;
  assert.deepEqual(parseList(entry({})), [{ id: 'wallet', title: 'Wallet', repository: 'org/bb-wallet', ref: 'main', description: '' }]);
  assert.throws(() => parseList('building_blocks: []\n'), /non-empty list/);
  assert.throws(() => parseList(entry({ id: 'Wallet' })), /kebab-case/);
  assert.throws(() => parseList(entry({ repository: 'https://github.com/org/bb-wallet' })), /owner\/name/);
  assert.throws(() => parseList(entry({ ref: '--upload-pack=x' })), /branch, tag or commit/);
  assert.throws(() => parseList(entry({ ref: 'a..b' })), /branch, tag or commit/);
  const twice = `${entry({})}  - id: wallet\n    title: Again\n    repository: org/other\n    ref: main\n`;
  assert.throws(() => parseList(twice), /listed twice/);
});

test('the landing page links each Building Block under the base and names the built commit', () => {
  const html = landingHtml(
    [{ id: 'wallet', title: 'Wallet <2.0>', repository: 'org/bb-wallet', ref: 'feat/v2.0', description: 'Draft.', commit: 'ef465f8442070207e5f3bff4b594641f4fe9a92e' }],
    { base: '/govstack-specification-site/', unofficial: true },
  );
  assert.match(html, /href="\/govstack-specification-site\/bb\/wallet\/">Wallet &lt;2\.0&gt;<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/org\/bb-wallet\/tree\/ef465f8442070207e5f3bff4b594641f4fe9a92e"/);
  assert.match(html, /<code>feat\/v2\.0 @ ef465f8<\/code>/);
  assert.match(html, /Unofficial preview/);
  assert.match(html, /content="noindex, nofollow"/);
  assert.doesNotMatch(landingHtml([], { base: '/', unofficial: false }), /Unofficial preview/);
});
