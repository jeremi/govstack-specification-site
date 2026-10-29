import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { normalizePublication, resolveBuild, siteRoot, writeCrawlerPolicy } from './publication.mjs';
import { checkBuilt } from './check-built.mjs';
import { checkServed } from './check-served.mjs';
import { withRendererLock } from './lock.mjs';
import { assertSafeOutputTree, promoteBuild } from './output.mjs';

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: siteRoot, env, stdio: 'inherit' });
    let interrupted;
    let timeout;
    const interrupt = (signal) => {
      interrupted = signal;
      child.kill(signal);
      timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      timeout.unref();
    };
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const cleanup = () => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(`${command} exited with ${interrupted || signal || code}`));
    });
  });
}

async function generate(build) {
  // This is renderer-owned scratch, never a source repository or static preview.
  try {
    if ((await lstat(build.workspace)).isSymbolicLink()) throw new Error('Generated workspace must not be a symlink');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(build.workspace, { recursive: true, force: true });
  await mkdir(build.workspace, { recursive: true });
  const adapter = await import(`../adapters/${build.adapter}.mjs`);
  const raw = await adapter.generateSite({ sourceRoot: build.sourceRoot, siteRoot: build.workspace, base: build.base, unofficial: build.unofficial, sourceUrl: build.sourceUrl });
  const publication = normalizePublication(raw, build);
  publication.pages = await Promise.all(publication.pages.map(async (page) => {
    const generated = await readFile(path.join(build.workspace, 'src/content/docs', page.route ? `${page.route}.md` : 'index.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(generated);
    if (!frontmatter) throw new Error(`${page.source}: generated frontmatter is missing`);
    return { ...page, searchable: YAML.parse(frontmatter[1]).pagefind !== false };
  }));
  await cp(path.join(siteRoot, 'public'), path.join(build.workspace, 'public'), { recursive: true });
  await writeCrawlerPolicy(build.workspace, build.unofficial);
  await writeFile(path.join(build.workspace, 'publication.json'), `${JSON.stringify(publication, null, 2)}\n`);
  console.log(`${publication.title}: ${publication.pages.length} pages, ${publication.sourceDigest}`);
  return publication;
}

async function checkedOutput(build, publication, served) {
  const result = await checkBuilt({ distDir: build.distDir, manifest: publication, base: build.base });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  console.log(`Built checks passed: ${result.pages} pages, ${result.links} local links/assets, source anchors, and search.`);
  if (served) {
    const result = await checkServed({ siteRoot, distDir: build.distDir, manifest: publication, base: build.base, workspace: build.workspace });
    console.log(`HTTP checks passed: ${JSON.stringify(result)}`);
  }
}

export function parseCli(args) {
  return parseArgs({ args, allowPositionals: true, options: {
    profile: { type: 'string' }, source: { type: 'string' }, output: { type: 'string' }, base: { type: 'string' }, port: { type: 'string' },
    unofficial: { type: 'boolean' }, 'source-url': { type: 'string' },
  } });
}

// Each option falls back to its DOCS_* variable; DOCS_UNOFFICIAL is on for any value other than empty or 0.
export function buildOptions(values, env) {
  return { profile: values.profile || env.DOCS_PROFILE || 'api-guide', sourceRoot: values.source || env.DOCS_SOURCE_ROOT, distDir: values.output || env.DOCS_DIST_DIR, base: values.base || env.DOCS_BASE || '/', unofficial: values.unofficial ?? !['', '0', undefined].includes(env.DOCS_UNOFFICIAL), sourceUrl: values['source-url'] || env.DOCS_SOURCE_URL || undefined };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseCli(args);
  const command = positionals[0] || 'check';
  if (!['generate', 'dev', 'build', 'preview', 'test', 'check-built', 'test-served', 'check'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'test') return run(process.execPath, ['--test', 'tests/*.test.mjs'], process.env);
  const options = buildOptions(values, process.env);
  let build = resolveBuild(options);
  build = resolveBuild({ ...options, sourceRoot: await realpath(build.sourceRoot) });
  const generatedRoot = path.join(siteRoot, '.generated');
  await mkdir(generatedRoot, { recursive: true });
  if (await realpath(generatedRoot) !== generatedRoot) throw new Error('Generated root must not be redirected by symlinks');
  const env = { ...process.env, GOVSTACK_SITE_WORKSPACE: build.workspace, DOCS_DIST_DIR: build.distDir, DOCS_BASE: build.base, ASTRO_TELEMETRY_DISABLED: '1' };
  const astro = path.join(siteRoot, 'node_modules/astro/bin/astro.mjs');
  const config = ['--config', 'astro.config.mjs'];
  if (['preview', 'check-built', 'test-served'].includes(command)) await assertSafeOutputTree(build.distDir);
  if (command === 'preview') return run(process.execPath, [astro, 'preview', ...config, '--ignore-lock', '--host', '127.0.0.1', ...(values.port ? ['--port', values.port] : [])], env);
  if (command === 'check-built' || command === 'test-served') {
    const publication = JSON.parse(await readFile(path.join(build.workspace, 'publication.json'), 'utf8'));
    return checkedOutput(build, publication, command === 'test-served');
  }
  const locksRoot = path.join(generatedRoot, 'locks');
  await mkdir(locksRoot, { recursive: true });
  return withRendererLock(path.join(locksRoot, build.workspaceKey), async () => {
    if (command === 'check') await run(process.execPath, ['--test', 'tests/*.test.mjs'], env);
    const publication = await generate(build);
    if (command === 'generate') return;
    await withRendererLock(path.join(locksRoot, 'astro'), async () => {
      if (command === 'dev') return run(process.execPath, [astro, 'dev', ...config, '--host', '127.0.0.1', ...(values.port ? ['--port', values.port] : [])], env);
      await assertSafeOutputTree(build.distDir);
      const stagedOutput = path.join(build.workspace, 'build-output');
      const buildEnv = { ...env, DOCS_DIST_DIR: stagedOutput };
      await run(process.execPath, [astro, 'check', ...config], buildEnv);
      await run(process.execPath, [astro, 'build', ...config], buildEnv);
      const result = await checkBuilt({ distDir: stagedOutput, manifest: publication, base: build.base });
      if (result.errors.length) throw new Error(result.errors.join('\n'));
      await promoteBuild(stagedOutput, build.distDir);
    });
    if (command === 'check') await checkedOutput(build, publication, true);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
