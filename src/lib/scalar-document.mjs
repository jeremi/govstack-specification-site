const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

/**
 * Scalar 1.76 ignores description siblings on operation response references.
 * Inline only those responses in its display copy, preserving the source download.
 */
export function scalarDocument(document) {
  const display = structuredClone(document);
  if (!/^3\.1(?:\.|$)/.test(display.openapi ?? '')) return display;

  function responseValue(value, seen = new Set()) {
    if (!value?.$ref) return value;
    const reference = value.$ref;
    if (typeof reference !== 'string' || !reference.startsWith('#/')) {
      throw new Error('Expected a bundled local response reference');
    }
    if (seen.has(reference)) throw new Error(`Cyclic response reference: ${reference}`);
    seen.add(reference);
    let target = display;
    for (const part of reference.slice(2).split('/')) {
      const key = decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~');
      target = target && Object.hasOwn(target, key) ? target[key] : undefined;
    }
    if (!target || typeof target !== 'object') throw new Error(`Missing response reference: ${reference}`);
    return {
      ...responseValue(target, seen),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
    };
  }

  for (const item of Object.values(display.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!METHODS.has(method)) continue;
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (response?.$ref && typeof response.description === 'string') {
          operation.responses[status] = responseValue(response);
        }
      }
    }
  }
  return display;
}
