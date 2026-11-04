import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';

import { siteRoot as rendererRoot } from './publication.mjs';
import { isPublishableSupportPath } from './support-paths.mjs';

const execFileAsync = promisify(execFile);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const CONFIG_KEYS = new Set(['id', 'page', 'contract', 'role', 'operationId', 'response', 'example']);
const html = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const urlFor = (base, relative) => `${base.replace(/\/+$/, '')}/${relative}`;

function relativePath(value, label) {
  if (typeof value !== 'string' || !value || path.posix.isAbsolute(value) || /[\\?#:]/.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid ${label} path: ${String(value)}`);
  }
  if (!isPublishableSupportPath(value)) throw new Error(`${label} is not a publishable source path: ${value}`);
  return value;
}

function validateReferences(config) {
  if (!config || !Array.isArray(config.references) || Object.keys(config).some((key) => key !== 'references')) {
    throw new Error('api-references.yml requires a references list');
  }
  const ids = new Set();
  const pages = new Set();
  return config.references.map((reference) => {
    if (!reference || typeof reference !== 'object' || Object.keys(reference).some((key) => !CONFIG_KEYS.has(key))) throw new Error('Unknown API reference configuration member');
    if (!/^[a-z][a-z0-9-]*$/.test(reference.id ?? '')) throw new Error('API reference id must be a lowercase identifier');
    if (ids.has(reference.id)) throw new Error(`Duplicate API reference id: ${reference.id}`);
    ids.add(reference.id);
    relativePath(reference.page, 'page');
    if (!reference.page.endsWith('.md')) throw new Error('API reference page must be Markdown');
    if (pages.has(reference.page)) throw new Error(`Duplicate API reference page: ${reference.page}`);
    pages.add(reference.page);
    relativePath(reference.contract, 'contract');
    if (!['normative', 'example'].includes(reference.role)) throw new Error(`Unknown API reference role: ${reference.role}`);
    const hasOperationId = reference.operationId !== undefined;
    const hasResponse = reference.response !== undefined;
    if (hasOperationId && (typeof reference.operationId !== 'string' || !reference.operationId.trim() || reference.operationId === 'undefined')) throw new Error('API reference operationId must be nonempty');
    if (hasResponse && (typeof reference.response !== 'string' || !/^2\d\d$/.test(reference.response))) throw new Error('API reference response must identify a successful HTTP status');
    if (reference.example !== undefined && (typeof reference.example !== 'string' || !reference.example)) throw new Error('Named response example must be nonempty');
    if (hasOperationId !== hasResponse) throw new Error(`API reference ${hasOperationId ? 'response' : 'operationId'} is required when selecting a response example`);
    if (reference.example !== undefined && !hasOperationId) throw new Error('Named response example requires operationId and response');
    return { ...reference, label: reference.role === 'normative' ? 'Normative contract (draft)' : 'Illustrative example' };
  });
}

async function loadDependencies(sourceRoot, relative, snapshots, documents) {
  relativePath(relative, 'contract dependency');
  const source = path.join(sourceRoot, relative);
  const resolved = await realpath(source);
  if (!resolved.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`Contract dependency symlink escapes the source: ${relative}`);
  const actualRelative = path.relative(sourceRoot, resolved).split(path.sep).join('/');
  relativePath(actualRelative, 'resolved contract dependency');
  if (documents.has(relative)) return;
  const bytes = await readFile(source);
  const document = YAML.parse(bytes.toString('utf8'));
  snapshots.set(relative, bytes);
  documents.set(relative, document);
  const dependencies = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of ['$ref', '$dynamicRef']) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== 'string') throw new Error(`${relative}: invalid ${key}`);
      const target = decodeURIComponent(value[key].split('#')[0]);
      if (!target) continue;
      if (path.posix.isAbsolute(target) || target.startsWith('\\')) throw new Error(`${relative}: absolute references outside source-relative resolution are not permitted: ${value[key]}`);
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('//')) throw new Error(`${relative}: remote references are not permitted: ${value[key]}`);
      dependencies.add(path.posix.normalize(path.posix.join(path.posix.dirname(relative), target)));
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(document);
  for (const dependency of dependencies) await loadDependencies(sourceRoot, dependency, snapshots, documents);
}

function resolved(document, value, seen = new Set()) {
  if (!value?.$ref) return value;
  if (!value.$ref.startsWith('#/')) throw new Error(`Unbundled reference: ${value.$ref}`);
  if (seen.has(value.$ref)) throw new Error(`Cyclic reference while selecting response example: ${value.$ref}`);
  seen.add(value.$ref);
  let target = document;
  for (const part of value.$ref.slice(2).split('/')) target = target?.[decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~')];
  if (target === undefined) throw new Error(`Missing bundled reference: ${value.$ref}`);
  const result = resolved(document, target, seen);
  return { ...result, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) };
}

function schemaExample(document, schema) {
  const value = resolved(document, schema);
  if (!value || typeof value !== 'object') return undefined;
  if (value.example !== undefined) return value.example;
  if (Array.isArray(value.examples) && value.examples.length) return value.examples[0];
  for (const branch of value.allOf ?? []) {
    const example = schemaExample(document, branch);
    if (example !== undefined) return example;
  }
  return undefined;
}

function contractOperations(document) {
  return Object.entries(document.paths ?? {}).flatMap(([route, pathItem]) => {
    const item = resolved(document, pathItem);
    return Object.entries(item).filter(([method]) => METHODS.has(method)).map(([method, operation]) => ({ method, path: route, ...resolved(document, operation) }));
  });
}

function selectedExample(document, operations, reference) {
  const matches = operations.filter((operation) => operation.operationId === reference.operationId);
  if (matches.length !== 1) throw new Error(`${reference.id}: expected one operationId ${reference.operationId}`);
  const operation = matches[0];
  const response = resolved(document, operation.responses?.[reference.response]);
  const media = response?.content?.['application/json'];
  if (!media) throw new Error(`${reference.id}: selected response has no application/json representation`);
  let value;
  if (reference.example !== undefined) {
    const example = resolved(document, media.examples?.[reference.example]);
    if (example?.value === undefined) throw new Error(`${reference.id}: unknown named response example ${reference.example}`);
    value = example.value;
  } else if (media.example !== undefined) value = media.example;
  else if (media.examples && Object.keys(media.examples).length) value = resolved(document, Object.values(media.examples)[0])?.value;
  else value = schemaExample(document, media.schema);
  if (value === undefined) throw new Error(`${reference.id}: no published example for response ${reference.response}; add one to the owning contract`);
  return { value, operationId: operation.operationId, method: operation.method, path: operation.path, status: reference.response };
}

/** Compile opt-in, source-owned reference declarations without modifying their contracts. */
export async function prepareApiReferences({ sourceRoot, siteRoot, base = '/', snapshots = new Map(), reservedPaths = [] }) {
  let configBytes;
  try { configBytes = await readFile(path.join(sourceRoot, 'api-references.yml')); }
  catch (error) { if (error.code === 'ENOENT') return { references: [], supportFiles: [] }; throw error; }
  const references = validateReferences(YAML.parse(configBytes.toString('utf8')));
  snapshots.set('api-references.yml', configBytes);
  if (!references.length) return { references: [], supportFiles: [] };
  const scriptPath = 'api-reference/scalar-1.76.4.js';
  const outputs = [scriptPath, ...references.map((reference) => `api-reference/${reference.id}.json`)];
  for (const output of outputs) {
    if (reservedPaths.some((reserved) => reserved === output || output.startsWith(`${reserved}/`) || reserved.startsWith(`${output}/`))) {
      throw new Error(`Generated API reference output collides with source support file: ${output}`);
    }
  }
  const source = await realpath(sourceRoot);
  const documents = new Map();
  for (const reference of references) await loadDependencies(source, reference.contract, snapshots, documents);
  const sourceFiles = [...documents.keys()].toSorted();
  for (const output of outputs) {
    if (sourceFiles.some((sourceFile) => sourceFile === output || sourceFile.startsWith(`${output}/`) || output.startsWith(`${sourceFile}/`))) {
      throw new Error(`Generated API reference output collides with source contract dependency: ${output}`);
    }
  }
  const publicRoot = path.join(siteRoot, 'public');
  const outputRoot = path.join(publicRoot, 'api-reference');
  await mkdir(outputRoot, { recursive: true });
  for (const sourceFile of sourceFiles) {
    const destination = path.join(publicRoot, sourceFile);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, snapshots.get(sourceFile));
  }
  const bundlerConfig = path.join(siteRoot, 'api-reference-bundler.yml');
  await writeFile(bundlerConfig, 'extends: []\n');
  const scriptUrl = urlFor(base, scriptPath);
  await copyFile(path.join(rendererRoot, 'node_modules/@scalar/api-reference/dist/browser/standalone.js'), path.join(publicRoot, scriptPath));
  const supportFiles = [...sourceFiles, scriptPath];
  for (const reference of references) {
    const relative = `api-reference/${reference.id}.json`;
    const output = path.join(publicRoot, relative);
    try {
      await execFileAsync(process.execPath, [path.join(rendererRoot, 'node_modules/@redocly/cli/bin/cli.js'), 'bundle', path.join(source, reference.contract), '--config', bundlerConfig, '--output', output, '--ext', 'json'], { cwd: rendererRoot, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`${reference.id}: OpenAPI bundling failed: ${String(error.stderr ?? error.message).slice(0, 2000)}`);
    }
    const bytes = await readFile(output);
    const document = JSON.parse(bytes);
    const operations = contractOperations(document);
    reference.contractUrl = urlFor(base, relative);
    reference.sourceUrl = urlFor(base, reference.contract);
    reference.scriptUrl = scriptUrl;
    reference.bundleSha256 = createHash('sha256').update(bytes).digest('hex');
    if (reference.operationId !== undefined) {
      reference.example = selectedExample(document, operations, reference);
    }
    reference.metadata = {
      openapi: document.openapi,
      operations: operations.map((operation) => ({
        method: operation.method,
        path: operation.path,
        operationId: operation.operationId,
        ...Object.fromEntries(
          Object.entries(operation).filter(([key]) => key.startsWith('x-')),
        ),
      })),
    };
    supportFiles.push(relative);
  }
  return { references, supportFiles };
}

/** Native reference host; response examples remain in the owning OpenAPI contract. */
export function apiReferenceMarkup(reference) {
  const label = reference.role === 'normative' ? 'Normative contract (draft)' : 'Illustrative example';
  const scope = reference.role === 'normative' ? 'Draft transport contract; example values are illustrative.' : 'This example does not add requirements to the normative contract.';
  return `<section class="api-reference-native" data-api-reference-role="${html(reference.role)}">
<div class="api-reference-toolbar"><span class="api-reference-badge" title="${html(scope)}">${html(label)}</span><span class="api-reference-links">${reference.sourceUrl ? `<a href="${html(reference.sourceUrl)}">Source OpenAPI</a> · ` : ''}<a href="${html(reference.contractUrl)}">Download OpenAPI</a></span></div>
<details class="api-technical-metadata"><summary>Technical metadata</summary><pre><code>${html(JSON.stringify(reference.metadata, null, 2))}</code></pre></details>
<div data-scalar-reference data-contract-url="${html(reference.contractUrl)}" data-script-url="${html(reference.scriptUrl)}"></div>
<noscript>JavaScript is needed for the interactive reference. Use the OpenAPI download above.</noscript>
</section>\n`;
}

export function apiReferenceSidebar(sidebar, references, pagesBySource) {
  if (!references.length) return sidebar;
  const sources = new Set(references.map((reference) => reference.page));
  function retain(items) {
    return items.flatMap((item) => {
      if (item.items) { const children = retain(item.items); return children.length ? [{ ...item, items: children }] : []; }
      return [...sources].some((source) => pagesBySource.get(source)?.route === item.slug) ? [] : [item];
    });
  }
  const navigation = retain(sidebar);
  const groups = ['normative', 'example'].flatMap((role) => {
    const items = references.filter((reference) => reference.role === role).map((reference) => ({ label: pagesBySource.get(reference.page).title, slug: pagesBySource.get(reference.page).route }));
    return items.length ? [{ label: role === 'normative' ? 'Normative draft' : 'Illustrative examples', items }] : [];
  });
  navigation.splice(Math.min(3, navigation.length), 0, { label: 'API reference', items: groups });
  return navigation;
}
