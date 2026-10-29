import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withRendererLock } from '../scripts/lock.mjs';

test('an interrupted owner releases its lock and a later command can proceed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(),'govstack-lock-'));
  t.after(()=>rm(root,{recursive:true}));
  const target=path.join(root,'renderer');
  const module=new URL('../scripts/lock.mjs',import.meta.url).href;
  const script=`import {withRendererLock} from ${JSON.stringify(module)}; await withRendererLock(${JSON.stringify(target)},async()=>{process.send('ready');await new Promise(()=>{setInterval(()=>{},1000)});});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>child.kill('SIGKILL'));
  await once(child,'message');
  await assert.rejects(withRendererLock(target,async()=>{}, {retries:0}), /already being held/);
  child.kill('SIGTERM');
  await once(child,'exit');
  await assert.rejects(stat(`${target}.lock`),{code:'ENOENT'});
  assert.equal(await withRendererLock(target,async()=>42),42);
});

test('a stale lock from a crashed owner is recovered', async (t) => {
  const root=await mkdtemp(path.join(tmpdir(),'govstack-stale-lock-'));
  t.after(()=>rm(root,{recursive:true}));
  const target=path.join(root,'renderer');
  await mkdir(`${target}.lock`);
  await utimes(`${target}.lock`,new Date(0),new Date(0));
  assert.equal(await withRendererLock(target,async()=>true),true);
});
