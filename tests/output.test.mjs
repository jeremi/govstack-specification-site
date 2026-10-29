import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSafeOutputTree, promoteBuild } from '../scripts/output.mjs';

test('promotion copies a verified build and preserves unrelated existing files', async(t)=>{
  const root=await mkdtemp(path.join(tmpdir(),'govstack-output-'));
  t.after(()=>rm(root,{recursive:true}));
  const staged=path.join(root,'staged'), output=path.join(root,'output');
  await mkdir(staged);await mkdir(output);
  await writeFile(path.join(staged,'index.html'),'<h1>Draft</h1>');
  await writeFile(path.join(output,'keep.txt'),'existing');
  await promoteBuild(staged,output);
  assert.equal(await readFile(path.join(output,'index.html'),'utf8'),'<h1>Draft</h1>');
  assert.equal(await readFile(path.join(output,'keep.txt'),'utf8'),'existing');
});

test('promotion rejects destination symlinks and obsolete HTML before changing output', async(t)=>{
  const root=await mkdtemp(path.join(tmpdir(),'govstack-output-guard-'));
  t.after(()=>rm(root,{recursive:true}));
  const staged=path.join(root,'staged'), output=path.join(root,'output');
  await mkdir(staged);await mkdir(output);
  await writeFile(path.join(staged,'index.html'),'new');
  await writeFile(path.join(output,'index.html'),'old');
  await writeFile(path.join(output,'obsolete.html'),'preserve');
  await assert.rejects(promoteBuild(staged,output),/fresh output/);
  assert.equal(await readFile(path.join(output,'index.html'),'utf8'),'old');
  await symlink(path.join(staged,'index.html'),path.join(output,'linked.html'));
  await assert.rejects(assertSafeOutputTree(output),/symlink/);
});

test('promotion rejects operational files in staging or an existing output without changing files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'govstack-output-operational-'));
  t.after(() => rm(root, { recursive: true }));
  const staged = path.join(root, 'staged');
  const output = path.join(root, 'output');
  await mkdir(staged);
  await mkdir(output);
  await writeFile(path.join(staged, 'index.html'), 'new');
  await writeFile(path.join(output, 'index.html'), 'old');
  await writeFile(path.join(output, '.env'), 'INERT_FIXTURE=example');
  await assert.rejects(promoteBuild(staged, output), /operational.*fresh output/i);
  assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(output, '.env'), 'utf8'), 'INERT_FIXTURE=example');
  const fresh = path.join(root, 'fresh');
  await writeFile(path.join(staged, '.env'), 'INERT_FIXTURE=example');
  await assert.rejects(promoteBuild(staged, fresh), /operational/i);
});
