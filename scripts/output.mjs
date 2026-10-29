import { cp, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isPublishableSupportPath } from './support-paths.mjs';

export async function assertSafeOutputTree(root) {
  let entry;
  try { entry = await lstat(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (entry.isSymbolicLink()) throw new Error(`Output contains a symlink: ${root}`);
  if (!entry.isDirectory()) throw new Error(`Output must be a directory: ${root}`);
  for (const child of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, child.name);
    if (!isPublishableSupportPath(child.name)) throw new Error(`Output contains an operational path: ${file}; choose a fresh output directory to preserve it.`);
    if (child.isSymbolicLink()) throw new Error(`Output contains a symlink: ${file}`);
    if (child.isDirectory()) await assertSafeOutputTree(file);
  }
}

/** Copy across volumes without deleting an existing preview or unrelated files. */
export async function promoteBuild(staged, output) {
  await assertSafeOutputTree(staged);
  await assertSafeOutputTree(output);
  const expected = new Set(await readdir(staged, { recursive: true }));
  let existing = [];
  try { existing = await readdir(output, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing.some((file) => file.endsWith('.html') && !expected.has(file))) throw new Error('Existing HTML is absent from this build; choose a fresh output directory to preserve it.');
  await mkdir(output, { recursive: true });
  await cp(staged, output, { recursive: true });
}
