import { lazy } from 'react';

const CHUNK_LOAD_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /error loading dynamically imported module/i,
  /unable to preload css/i,
  /loading (?:css )?chunk .* failed/i,
];

/**
 * Returns true when an error indicates a stale or interrupted dynamic module/chunk fetch
 * (most commonly after a new deployment replaces hashed asset URLs).
 */
export function isChunkLoadError(error) {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  const message = String(error.message || error);
  return CHUNK_LOAD_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Invokes a dynamic module loader with a bounded retry for transient network failures.
 * Persistent 404/chunk mismatches rethrow cleanly for a local AsyncBoundary to handle.
 */
export async function importWithRetry(
  loader,
  {
    retries = 1,
    retryDelayMs = 250,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {},
) {
  let attempt = 0;
  while (true) {
    try {
      return await loader();
    } catch (error) {
      if (!isChunkLoadError(error) || attempt >= retries) {
        throw error;
      }
      attempt += 1;
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
}

/**
 * Wraps React.lazy with importWithRetry and named-export resolution.
 */
export function lazyWithRetry(loader, exportName = 'default') {
  return lazy(() => importWithRetry(async () => {
    const mod = await loader();
    if (exportName === 'default' && mod?.default) {
      return mod;
    }
    return { default: mod?.[exportName] };
  }));
}
