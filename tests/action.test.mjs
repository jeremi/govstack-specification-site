import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import YAML from 'yaml';
import { generateSite } from '../adapters/framework.mjs';

const exec = promisify(execFile);
const actionPath = new URL('../action.yml', import.meta.url);

test('shared build action installs the pinned toolchain without deployment or install scripts', async () => {
  const action = YAML.parse(await readFile(actionPath, 'utf8'));
  assert.equal(action.runs.using, 'composite');
  assert.equal(action.inputs.profile.default, 'framework');
  assert.equal(action.inputs.unofficial.default, 'true');
  assert.equal(action.inputs.source.required, true);
  assert.equal(action.inputs.output.required, true);
  const setup = action.runs.steps.find((step) => step.uses);
  assert.match(setup.uses, /^actions\/setup-node@[a-f0-9]{40}$/);
  assert.equal(setup.with['node-version'], '24');
  assert.ok(action.runs.steps.some((step) => /npm ci --ignore-scripts/.test(step.run ?? '')));
  assert.doesNotMatch(JSON.stringify(action), /deploy-pages|pages: write|id-token: write|persist-credentials/);
});

test('shared action passes consumer paths and options as data, independent of renderer directory', async (t) => {
  const action = YAML.parse(await readFile(actionPath, 'utf8'));
  const step = action.runs.steps.find((step) => step.id === 'build');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'govstack-action-'));
  t.after(() => rm(scratch, { recursive: true }));
  const renderer = path.join(scratch, 'renderer with spaces');
  const workspace = path.join(scratch, 'consumer');
  await mkdir(path.join(renderer, 'scripts'), { recursive: true });
  await mkdir(workspace);
  await writeFile(path.join(renderer, 'scripts/site.mjs'), `
    const keys = ['DOCS_PROFILE', 'DOCS_SOURCE_ROOT', 'DOCS_DIST_DIR', 'DOCS_BASE', 'DOCS_UNOFFICIAL', 'DOCS_SOURCE_URL'];
    console.log(JSON.stringify({ args: process.argv.slice(2), options: Object.fromEntries(keys.map(key => [key, process.env[key]])), cwd: process.cwd() }));
  `);
  const env = {
    ...process.env,
    GOVSTACK_RENDERER_ROOT: renderer,
    DOCS_PROFILE: 'framework',
    DOCS_SOURCE_ROOT: path.join(workspace, 'specification'),
    DOCS_DIST_DIR: path.join(scratch, 'output with spaces'),
    DOCS_BASE: '/building-block/',
    DOCS_UNOFFICIAL: '1',
    DOCS_SOURCE_URL: '',
  };
  const { stdout } = await exec('bash', ['-c', step.run], { cwd: workspace, env });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.args, ['check']);
  assert.equal(result.cwd, await realpath(workspace));
  for (const key of Object.keys(result.options)) assert.equal(result.options[key], env[key]);
  assert.match(step.env.GOVSTACK_RENDERER_ROOT, /github\.action_path/);
  assert.match(step.env.DOCS_SOURCE_ROOT, /inputs\.source/);
  assert.match(step.env.DOCS_DIST_DIR, /inputs\.output/);
  assert.match(step.env.DOCS_BASE, /inputs\.base/);
});

test('the reusable example builds a generic API page from a minimal declaration', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'govstack-adoption-'));
  t.after(() => rm(scratch, { recursive: true }));
  const manifest = await generateSite({ sourceRoot: path.resolve(import.meta.dirname, '../examples/building-block'), siteRoot: scratch, base: '/example/' });
  assert.equal(manifest.apiReferences.length, 1);
  assert.equal(manifest.apiReferences[0].role, 'example');
  assert.ok(manifest.apiReferences[0].metadata.operations[0]['x-example-block']);
  const page = await readFile(path.join(scratch, 'src/content/docs/resources/api-example.md'), 'utf8');
  assert.match(page, /data-scalar-reference/);
  assert.doesNotMatch(page, /Digital Registries/);
  const guide = await readFile(path.join(scratch, 'src/content/docs/resources/guide.md'), 'utf8');
  assert.match(guide, /Example guide in the Example Building Block specification/);
  assert.doesNotMatch(guide, /Digital Registries/);
});
