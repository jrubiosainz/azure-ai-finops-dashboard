/**
 * Disk-backed TTL cache.
 *
 * The Cost Management API is rate limited to a handful of calls per minute and its
 * underlying data only refreshes every few hours, so the dashboard always reads from
 * this cache and refreshes explicitly rather than on every page load.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(here, '..', '.cache');

export function modelCacheKey(subscriptionId, { from, to }) {
  return `finops-v2-${subscriptionId}-${from}-${to}`;
}

async function ensureDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function fileFor(key) {
  const safe = key.replace(/[^a-z0-9._-]/gi, '_');
  return path.join(CACHE_DIR, `${safe}.json`);
}

export async function readCache(key, maxAgeMs = Infinity) {
  try {
    const raw = await fs.readFile(fileFor(key), 'utf8');
    const parsed = JSON.parse(raw);
    const age = Date.now() - new Date(parsed.cachedAt).getTime();
    if (age > maxAgeMs) return null;
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`No se pudo leer la cache ${key}: ${error.message}`, { cause: error });
  }
}

export async function writeCache(key, data) {
  await ensureDir();
  const envelope = { cachedAt: new Date().toISOString(), data };
  await fs.writeFile(fileFor(key), JSON.stringify(envelope), 'utf8');
  return envelope;
}

/** Returns cached data when fresh, otherwise recomputes and stores it. */
export async function cached(key, maxAgeMs, producer) {
  const hit = await readCache(key, maxAgeMs);
  if (hit) return { ...hit, fromCache: true };
  const data = await producer();
  const stored = await writeCache(key, data);
  return { ...stored, fromCache: false };
}

export async function cacheStatus() {
  try {
    await ensureDir();
    const files = await fs.readdir(CACHE_DIR);
    const entries = [];
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      const stat = await fs.stat(path.join(CACHE_DIR, f));
      entries.push({
        key: f.replace(/\.json$/, ''),
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (error) {
    throw new Error(`No se pudo consultar la cache: ${error.message}`, { cause: error });
  }
}

export { CACHE_DIR };
