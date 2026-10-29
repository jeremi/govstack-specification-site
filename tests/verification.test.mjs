import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { parse } from 'parse5';
import { generateSite } from '../adapters/api-guide.mjs';

test('renders plain verification details while legacy class metadata stays nonvisible', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'govstack-verification-'));
  t.after(() => rm(root, { recursive: true }));
  const sourceRoot = path.join(root, 'source');
  const siteRoot = path.join(root, 'output');
  await mkdir(path.join(sourceRoot, 'linter'), { recursive: true });
  const page = `---
description: "A verification fixture."
---
# Candidate API specification

## 10.2 Timestamp values <a href="#102-timestamps" id="102-timestamps"></a>

<!-- rule-class: M -->
Timestamp values **MUST** use UTC.

<!-- verification:start -->
**Verification:** Partial linter check.

The linter checks schema formats; UTC values require implementation tests.
<!-- verification:end -->
`;
  await writeFile(path.join(sourceRoot, 'README.md'), page);
  await writeFile(path.join(sourceRoot, 'SUMMARY.md'), '* [Candidate](README.md)\n');
  await writeFile(path.join(sourceRoot, 'rules.yaml'), 'version: 0.3.0-draft\nrules:\n  - id: "10.2"\n    class: M\n');
  await writeFile(path.join(sourceRoot, 'linter/coverage.yaml'), 'rules: []\n');
  execFileSync('git', ['init', '-q', sourceRoot]);
  execFileSync('git', ['-C', sourceRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'test: capture fixture baseline']);
  const manifest = await generateSite({ sourceRoot, siteRoot });
  assert.ok(manifest.pages[0].anchors.some((anchor) => anchor.id === '102-timestamps'));
  const generated = await readFile(path.join(siteRoot, 'src/content/docs/index.md'), 'utf8');
  assert.match(generated, /<!-- rule-class: M -->/);
  assert.match(generated, /\*\*Verification:\*\* Partial linter check/);
  const renderer = await createMarkdownProcessor({ syntaxHighlight: false });
  const html = (await renderer.render(generated.replace(/^---[\s\S]*?---\n/, ''))).code;
  const text = (node) => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');
  const visible = text(parse(html));
  assert.doesNotMatch(visible, /rule-class|verification:start|\[M\]|\[R\]/);
  assert.match(visible, /Verification: Partial linter check/);
  assert.match(visible, /UTC values require implementation tests/);
  assert.equal(await readFile(path.join(sourceRoot, 'README.md'), 'utf8'), page);
});
