import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const profiles = {
  'api-guide': { adapter: 'api-guide', contentWidth: '48rem' },
  framework: { adapter: 'framework', contentWidth: '56rem' },
};

function overlaps(first, second) {
  return first === second || first.startsWith(`${second}${path.sep}`) || second.startsWith(`${first}${path.sep}`);
}

function canonicalPath(candidate) {
  let ancestor = path.resolve(candidate);
  const missing = [];
  while (true) {
    try { return path.join(realpathSync(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error(`Dangling symlink in path: ${ancestor}`); }
      catch (entryError) { if (entryError.code !== 'ENOENT') throw entryError; }
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

export function resolveBuild({ profile = 'api-guide', sourceRoot, distDir, base = '/' } = {}) {
  const settings = profiles[profile];
  if (!settings) throw new Error(`Unknown profile: ${profile}`);
  const source = sourceRoot;
  if (!source) throw new Error(`${profile} requires an explicit source root`);
  if (!base.startsWith('/') || /[?#\\]/.test(base) || base.split('/').some((part) => part === '.' || part === '..')) throw new Error('Base must be an absolute URL path without traversal, query, or fragment');
  const sourcePath = canonicalPath(source);
  const workspaceKey = `${profile}-${createHash('sha256').update(sourcePath).digest('hex').slice(0, 12)}`;
  const workspace = path.join(siteRoot, '.generated', workspaceKey);
  const output = canonicalPath(distDir || path.join(siteRoot, 'dist', profile));
  if (overlaps(sourcePath, workspace) || overlaps(sourcePath, output) || overlaps(workspace, output)) throw new Error('Source, generated workspace, and output must not overlap');
  if (output.startsWith(`${siteRoot}${path.sep}`) && !output.startsWith(`${path.join(siteRoot, 'dist')}${path.sep}`)) throw new Error('Output inside the renderer must be under dist/');
  return { ...settings, profile, sourceRoot: sourcePath, workspaceKey, workspace, distDir: output, base: `${base.replace(/\/+$/, '')}/` };
}

export function normalizePublication(raw, build) {
  const downloads = build.profile === 'api-guide'
    ? [{ source: 'rules.yaml', output: 'downloads/rules.yaml', label: 'Rule index' }, { source: 'linter/coverage.yaml', output: 'downloads/linter/coverage.yaml', label: 'Linter coverage' }]
    : [{ source: 'metadata.yml', output: 'metadata.yml', label: 'Metadata' }, { source: 'authors.yml', output: 'authors.yml', label: 'Authors' }, { source: 'toc.yml', output: 'toc.yml', label: 'Navigation source' }];
  return {
    ...raw,
    schemaVersion: 1,
    profile: build.profile,
    publicationKind: raw.publicationKind ?? null,
    title: raw.title ?? raw.pages.find((page) => page.route === '')?.title,
    previewLabel: 'Local authoring preview',
    contentWidth: build.contentWidth,
    base: build.base,
    sourceRoot: build.sourceRoot,
    downloads,
    supportFiles: raw.supportFiles ?? downloads.map((item) => item.output),
    redirects: raw.redirects ?? [],
    supportIndexes: raw.supportIndexes ?? [],
  };
}

export function readPublication() {
  const workspace = process.env.GOVSTACK_SITE_WORKSPACE;
  if (!workspace) throw new Error('GOVSTACK_SITE_WORKSPACE is not set; run the renderer through scripts/site.mjs');
  return JSON.parse(readFileSync(path.join(workspace, 'publication.json'), 'utf8'));
}
