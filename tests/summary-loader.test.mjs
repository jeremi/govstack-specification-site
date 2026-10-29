import assert from 'node:assert/strict';
import test from 'node:test';
import { summaryDocsLoader } from '../scripts/summary-loader.mjs';

test('keeps only SUMMARY routes across HTML, search, and pagination inputs', async () => {
  const store = new Map([['orphan', {}], ['obsolete/nested', {}]]);
  const loader = summaryDocsLoader({ async load(context) {
    context.store.set('index', {});
    context.store.set('chapter', {});
  } }, [{ route: '' }, { route: 'chapter' }]);
  await loader.load({ store });
  assert.deepEqual([...store.keys()], ['index', 'chapter']);
});
