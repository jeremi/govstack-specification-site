import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'parse5';
import { assertSafeOutputTree } from './output.mjs';

function elements(node, result = []) {
  if (node.tagName) result.push(node);
  for (const child of node.childNodes ?? []) elements(child, result);
  return result;
}

function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function hasClass(node, name) {
  return attribute(node, 'class')?.split(/\s+/).includes(name) ?? false;
}

function hasAncestor(node, predicate) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (predicate(parent)) return true;
  }
  return false;
}

function robotsIncludes(nodes, directive) {
  return nodes.some(
    (node) =>
      node.tagName === 'meta' &&
      attribute(node, 'name')?.toLowerCase() === 'robots' &&
      attribute(node, 'content')
        ?.toLowerCase()
        .split(/[\s,]+/)
        .includes(directive),
  );
}

function textNodes(node, result = []) {
  if (node.nodeName === '#text') result.push(node);
  for (const child of node.childNodes ?? []) textNodes(child, result);
  return result;
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function basePath(base) {
  const parts = String(base).split('/').filter(Boolean);
  return parts.length === 0 ? '/' : `/${parts.join('/')}/`;
}

function outputPath(value) {
  if (typeof value !== 'string' || value.includes('\\')) return undefined;
  const normalized = path.posix.normalize(value.replace(/^\.\//, ''));
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return undefined;
  }
  return normalized;
}

function inside(root, relative) {
  const file = path.resolve(root, relative);
  const absoluteRoot = path.resolve(root);
  return file.startsWith(`${absoluteRoot}${path.sep}`) ? file : undefined;
}

function pageOutput(route) {
  const normalized = String(route ?? '')
    .split('/')
    .filter(Boolean)
    .join('/');
  return normalized ? `${normalized}/index.html` : 'index.html';
}

async function requireDeclaredFile({ distDir, errors, value, label }) {
  const relative = outputPath(value);
  if (!relative) {
    errors.push(`${String(value)}: invalid ${label} path`);
    return undefined;
  }
  const file = inside(distDir, relative);
  if (!file || !(await isFile(file)))
    errors.push(`${relative}: missing declared ${label}`);
  return relative;
}

/** Verify routes, stable citations, local references, and draft metadata in static output. */
export async function checkBuilt({ distDir, manifest, base = '/' }) {
  const errors = [];
  try { await assertSafeOutputTree(distDir); }
  catch (error) { return { errors: [error.message], pages: 0, links: 0 }; }
  const documents = new Map();
  const expectedHtml = new Set(['404.html']);

  for (const page of manifest.pages ?? [])
    expectedHtml.add(pageOutput(page.route));
  for (const supportFile of manifest.supportFiles ?? []) {
    const relative = await requireDeclaredFile({
      distDir,
      errors,
      value: supportFile,
      label: 'support file',
    });
    if (relative?.endsWith('.html')) expectedHtml.add(relative);
  }
  for (const supportIndex of manifest.supportIndexes ?? []) {
    const relative = await requireDeclaredFile({
      distDir,
      errors,
      value: supportIndex,
      label: 'support index',
    });
    if (relative) expectedHtml.add(relative);
  }
  for (const redirect of manifest.redirects ?? []) {
    const relative = await requireDeclaredFile({
      distDir,
      errors,
      value: redirect.legacy,
      label: 'redirect',
    });
    if (relative) expectedHtml.add(relative);
  }
  if (!(await isFile(path.join(distDir, '404.html'))))
    errors.push('404.html: missing built not-found page');

  for (const entry of await readdir(distDir, { recursive: true })) {
    const relative = entry.split(path.sep).join('/');
    if (relative.endsWith('.html') && !expectedHtml.has(relative)) {
      errors.push(`${relative}: page outside the source navigation manifest`);
    }
  }

  for (const page of manifest.pages ?? []) {
    const relative = pageOutput(page.route);
    const file = inside(distDir, relative);
    if (!file || !(await isFile(file))) {
      errors.push(`${page.source}: missing built page`);
      continue;
    }
    const nodes = elements(parse(await readFile(file, 'utf8')));
    const ids = nodes.map((node) => attribute(node, 'id')).filter(Boolean);
    const names = new Set(ids);
    if (names.size !== ids.length)
      errors.push(`${page.source}: duplicate HTML ids`);
    for (const heading of nodes.filter(
      (node) =>
        /^h[2-6]$/.test(node.tagName) &&
        attribute(node, 'id') &&
        hasAncestor(node, (parent) => hasClass(parent, 'sl-markdown-content')),
    )) {
      const id = attribute(heading, 'id');
      const wrapper = heading.parentNode;
      if (
        wrapper?.tagName !== 'div' ||
        !hasClass(wrapper, 'sl-heading-wrapper') ||
        !hasClass(wrapper, `level-${heading.tagName}`)
      ) {
        errors.push(
          `${page.source}: heading #${id} lacks a native Starlight heading wrapper`,
        );
        continue;
      }
      if (
        !(wrapper.childNodes ?? []).some(
          (node) =>
            node.tagName === 'a' &&
            hasClass(node, 'sl-anchor-link') &&
            attribute(node, 'href') === `#${id}`,
        )
      ) {
        errors.push(
          `${page.source}: heading #${id} lacks a matching Starlight anchor link`,
        );
      }
    }
    const unrenderedAside = nodes
      .filter((node) => hasClass(node, 'sl-markdown-content'))
      .flatMap((node) => textNodes(node))
      .some(
        (node) =>
          !hasAncestor(node, (parent) =>
            ['code', 'pre'].includes(parent.tagName),
          ) &&
          /(?:^|\n)\s*:::(?:note|tip|caution|danger)(?:\[[^\n]*\])?(?=\s*(?:\n|$))/i.test(
            node.value,
          ),
      );
    if (unrenderedAside) {
      errors.push(
        `${page.source}: contains an unrendered Starlight aside directive`,
      );
    }
    for (const anchor of page.anchors ?? []) {
      if (!names.has(anchor.id))
        errors.push(`${page.source}: missing source anchor #${anchor.id}`);
    }
    if (nodes.filter((node) => node.tagName === 'h1').length !== 1) {
      errors.push(`${page.source}: expected one page title`);
    }
    if (!robotsIncludes(nodes, 'noindex')) {
      errors.push(`${page.source}: missing draft noindex metadata`);
    }
    if (manifest.unofficial) {
      if (!nodes.some((node) => attribute(node, 'data-unofficial-banner') !== undefined))
        errors.push(`${page.source}: missing unofficial banner`);
      if (!robotsIncludes(nodes, 'nofollow'))
        errors.push(`${page.source}: missing unofficial nofollow metadata`);
    }
    if (
      page.searchable === false &&
      nodes.some(
        (node) =>
          node.tagName === 'main' &&
          attribute(node, 'data-pagefind-body') !== undefined,
      )
    ) {
      errors.push(
        `${page.source}: non-searchable page is exposed to the default Pagefind body index`,
      );
    }
    if (
      !nodes.some(
        (node) => node.tagName === 'html' && attribute(node, 'lang')?.trim(),
      )
    ) {
      errors.push(`${page.source}: missing document language`);
    }
    for (const node of nodes.filter((item) => item.tagName === 'img')) {
      if (attribute(node, 'alt') === undefined)
        errors.push(`${page.source}: image lacks alt text`);
    }
    documents.set(file, {
      names,
      nodes,
      route: String(page.route ?? '')
        .split('/')
        .filter(Boolean)
        .join('/'),
      source: page.source,
    });
  }

  if (manifest.unofficial) {
    const supportHtml = [...(manifest.redirects ?? []).map((item) => item.legacy), ...(manifest.supportIndexes ?? [])];
    for (const relative of new Set(supportHtml.map(outputPath).filter(Boolean))) {
      const file = inside(distDir, relative);
      if (file && (await isFile(file)) && !robotsIncludes(elements(parse(await readFile(file, 'utf8'))), 'nofollow'))
        errors.push(`${relative}: missing unofficial nofollow metadata`);
    }
    if (!(await isFile(path.join(distDir, 'robots.txt'))))
      errors.push('robots.txt: missing unofficial crawler policy');
  }

  const origin = 'https://local.invalid';
  const prefix = basePath(base);
  let links = 0;
  for (const document of documents.values()) {
    const current = new URL(
      `${prefix}${document.route ? `${document.route}/` : ''}`,
      origin,
    );
    for (const node of document.nodes) {
      const reference = attribute(
        node,
        node.tagName === 'a' || node.tagName === 'link' ? 'href' : 'src',
      );
      if (!reference || /^(?:mailto:|tel:|data:|javascript:)/i.test(reference))
        continue;
      let target;
      try {
        target = new URL(reference, current);
      } catch {
        errors.push(`${document.source}: invalid local target ${reference}`);
        continue;
      }
      if (target.origin !== origin) continue;
      links += 1;
      if (!target.pathname.startsWith(prefix)) {
        errors.push(`${document.source}: link escapes base: ${reference}`);
        continue;
      }
      let relative;
      try {
        relative = decodeURIComponent(target.pathname.slice(prefix.length));
      } catch {
        errors.push(`${document.source}: invalid local target ${reference}`);
        continue;
      }
      if (!relative || relative.endsWith('/')) relative += 'index.html';
      let targetFile = inside(distDir, relative);
      if (!targetFile) {
        errors.push(`${document.source}: invalid local target ${reference}`);
        continue;
      }
      if (!(await isFile(targetFile)) && !path.extname(targetFile)) {
        targetFile = path.join(targetFile, 'index.html');
      }
      if (!(await isFile(targetFile))) {
        errors.push(`${document.source}: missing local target ${reference}`);
        continue;
      }
      if (node.tagName === 'a' && target.hash && documents.has(targetFile)) {
        let fragment;
        try {
          fragment = decodeURIComponent(target.hash.slice(1));
        } catch {
          errors.push(`${document.source}: invalid fragment ${reference}`);
          continue;
        }
        if (!documents.get(targetFile).names.has(fragment)) {
          errors.push(`${document.source}: broken fragment ${reference}`);
        }
      }
    }
  }

  if (!(await isFile(path.join(distDir, 'pagefind/pagefind.js')))) {
    errors.push('Missing Pagefind search output');
  }
  return { errors, pages: documents.size, links };
}
