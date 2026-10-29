import lockfile from 'proper-lockfile';

/** Atomic locks are released on normal signals and recover after a crashed owner. */
export async function withRendererLock(target, operation, options = {}) {
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: 10_000,
    update: 2_000,
    retries: { retries: 6, minTimeout: 2_000, maxTimeout: 2_000 },
    ...options,
  });
  try { return await operation(); }
  finally { await release(); }
}
