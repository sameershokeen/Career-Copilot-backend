/**
 * In-memory cache — no Redis. A singleton Map-based store with per-key TTL.
 * Read-through: caller checks cache, on miss queries DB then writes to cache.
 * Write-invalidating: any mutation deletes the relevant keys.
 *
 * Key patterns & TTLs (per spec section 5):
 *   jobs:list:{filters_hash}     15 min
 *   jobs:detail:{job_id}         30 min
 *   user:profile:{user_id}       10 min  (invalidate on profile update)
 *   match:{user_id}:{job_id}     session (invalidate on resume update)
 *   resources:all                24 hr   (invalidate via admin cache-clear)
 *   community:feed:page:{n}      5 min   (invalidate on new post)
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number; // epoch ms, Infinity for "no TTL until manually cleared"
}

class CacheStore {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Delete every key starting with `prefix` — useful for e.g. "jobs:list:*" */
  deleteByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clearAll(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export const cache = new CacheStore();

export const TTL = {
  JOBS_LIST: 15 * 60 * 1000,
  JOBS_DETAIL: 30 * 60 * 1000,
  USER_PROFILE: 10 * 60 * 1000,
  RESOURCES_ALL: 24 * 60 * 60 * 1000,
  COMMUNITY_FEED_PAGE: 5 * 60 * 1000,
} as const;

/** Convenience read-through helper: get from cache, else compute + cache. */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>
): Promise<T> {
  const cached = cache.get<T>(key);
  if (cached !== undefined) return cached;
  const value = await compute();
  cache.set(key, value, ttlMs);
  return value;
}
