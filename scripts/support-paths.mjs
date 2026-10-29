const EXCLUDED_PARTS = new Set(['.git', '.venv', 'node_modules', '.ruff_cache', '__pycache__']);
const PUBLISHABLE_HIDDEN_PARTS = new Set(['.github', '.well-known']);

export function isPublishableSupportPath(relative) {
  if (typeof relative !== 'string' || relative === '' || relative.startsWith('/') || relative.includes('\\')) {
    return false;
  }
  const parts = relative.replace(/\/+$/, '').split('/');
  return parts.every(
    (part) =>
      part !== '' &&
      part !== '.' &&
      part !== '..' &&
      !EXCLUDED_PARTS.has(part) &&
      (!part.startsWith('.') || PUBLISHABLE_HIDDEN_PARTS.has(part)),
  );
}
