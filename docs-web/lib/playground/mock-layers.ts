type CacheOperationOptions =
  | number
  | {
      ttl?: number;
      staleWhileRevalidate?: number;
      tags?: string[];
      shouldCache?: (value: unknown) => boolean;
    };

type PlaygroundCacheOptions = {
  generation?: number;
  onLog?: (message: string) => void;
};

type CacheEntryState = "fresh" | "stale-while-revalidate";

type CacheEntry = {
  value: unknown;
  freshUntil: number;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 60_000;

function resolveOperationOptions(options: CacheOperationOptions = DEFAULT_TTL_MS) {
  if (typeof options === "number") {
    return { ttlMs: options, staleWhileRevalidateMs: 0, tags: undefined, shouldCache: undefined };
  }

  return {
    ttlMs: options.ttl ?? DEFAULT_TTL_MS,
    staleWhileRevalidateMs: options.staleWhileRevalidate ?? 0,
    tags: options.tags,
    shouldCache: options.shouldCache,
  };
}

// Simple in-memory cache layer mock
export class MockCacheLayer {
  private store = new Map<string, CacheEntry>();
  readonly name: string;
  readonly latencyMs: number;

  constructor(name: string, latencyMs: number) {
    this.name = name;
    this.latencyMs = latencyMs;
  }

  async get(key: string): Promise<unknown> {
    const entry = await this.getEntry(key);
    return entry?.state === "fresh" ? entry.value : undefined;
  }

  async getEntry(key: string): Promise<{ value: unknown; state: CacheEntryState } | undefined> {
    await this.simulateLatency();
    const entry = this.store.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return {
      value: entry.value,
      state: now > entry.freshUntil ? "stale-while-revalidate" : "fresh",
    };
  }

  async set(key: string, value: unknown, ttlMs: number, staleWhileRevalidateMs = 0): Promise<void> {
    await this.simulateLatency();
    const freshUntil = Date.now() + ttlMs;
    this.store.set(key, { value, freshUntil, expiresAt: freshUntil + staleWhileRevalidateMs });
  }

  async delete(key: string): Promise<boolean> {
    await this.simulateLatency();
    return this.store.delete(key);
  }

  async expire(key: string): Promise<boolean> {
    await this.simulateLatency();
    const entry = this.store.get(key);
    if (!entry) return false;

    this.store.set(key, { ...entry, freshUntil: Date.now() - 1 });
    return true;
  }

  async clear(): Promise<void> {
    await this.simulateLatency();
    this.store.clear();
  }

  size(): number {
    this.pruneExpired();
    return this.store.size;
  }

  keys(): string[] {
    this.pruneExpired();
    return Array.from(this.store.keys());
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  private simulateLatency(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

// Mock CacheStack that simulates the real behavior
export class MockCacheStack {
  private layers: MockCacheLayer[];
  private tags = new Map<string, Set<string>>(); // tag -> keys
  private keyTags = new Map<string, Set<string>>(); // key -> tags
  private stats = { hits: 0, misses: 0, sets: 0, deletes: 0, backfills: 0, staleHits: 0, refreshes: 0 };
  private inFlight = new Map<string, Promise<unknown>>();
  private generation: number | undefined;
  private onLog?: (message: string) => void;

  constructor(layers: MockCacheLayer[], options?: PlaygroundCacheOptions) {
    this.layers = layers;
    this.generation = options?.generation;
    this.onLog = options?.onLog;
  }

  async get<T>(
    key: string,
    fetcher?: (context: { key: string; currentValue: T | undefined; state: "miss" | "stale-while-revalidate" }) => Promise<T>,
    options: CacheOperationOptions = DEFAULT_TTL_MS
  ): Promise<T | null> {
    const operation = resolveOperationOptions(options);
    const storageKey = this.qualifyKey(key);

    // Try each layer
    for (const [index, layer] of this.layers.entries()) {
      const entry = await layer.getEntry(storageKey);
      if (entry) {
        this.stats.hits++;
        if (entry.state === "stale-while-revalidate") {
          this.stats.staleHits++;
          this.log(`[${layer.name}] STALE for key "${storageKey}"`);
          if (fetcher) {
            this.refreshStale(storageKey, key, entry.value as T, fetcher, operation);
          }
        } else {
          this.log(`[${layer.name}] HIT for key "${storageKey}"`);
        }
        if (index > 0) {
          await this.backfillUpperLayers(storageKey, entry.value as T, operation, index);
        }
        return entry.value as T;
      }
    }

    this.stats.misses++;
    this.log(`[MISS] Key "${storageKey}" not found in any layer`);

    // Stampede prevention: reuse in-flight fetcher for same key
    if (fetcher) {
      return this.fetchAndStore(storageKey, key, fetcher, operation);
    }

    return null;
  }

  async set<T>(key: string, value: T, options: CacheOperationOptions = DEFAULT_TTL_MS): Promise<void> {
    const operation = resolveOperationOptions(options);
    await this.storeInLayers(this.qualifyKey(key), value, operation);
  }

  private async storeInLayers<T>(key: string, value: T, operation: ReturnType<typeof resolveOperationOptions>): Promise<void> {
    this.stats.sets++;
    await Promise.all(this.layers.map((layer) => layer.set(key, value, operation.ttlMs, operation.staleWhileRevalidateMs)));
    if (operation.tags) {
      this.trackTags(key, operation.tags);
    }
    this.log(`[SET] Stored "${key}" in ${this.layers.length} layers`);
  }

  async delete(key: string): Promise<void> {
    const storageKey = this.qualifyKey(key);
    this.stats.deletes++;
    await Promise.all(this.layers.map((layer) => layer.delete(storageKey)));
    // Clean up tags
    const keyTagSet = this.keyTags.get(storageKey);
    if (keyTagSet) {
      for (const tag of keyTagSet) {
        this.tags.get(tag)?.delete(storageKey);
      }
      this.keyTags.delete(storageKey);
    }
    this.log(`[DELETE] Removed "${storageKey}" from all layers`);
  }

  async invalidateByKey(key: string): Promise<void> {
    await this.delete(key);
  }

  async invalidateByKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.delete(key);
    }
  }

  async expireByKey(key: string): Promise<void> {
    const storageKey = this.qualifyKey(key);
    await Promise.all(this.layers.map((layer) => layer.expire(storageKey)));
    this.log(`[EXPIRE] Marked "${storageKey}" stale in all layers`);
  }

  async expireByKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.expireByKey(key);
    }
  }

  async invalidateByTag(tag: string): Promise<number> {
    const keys = this.tags.get(tag);
    if (!keys || keys.size === 0) return 0;
    const count = keys.size;
    for (const key of keys) {
      await this.delete(key);
    }
    this.log(`[INVALIDATE] Removed ${count} keys with tag "${tag}"`);
    return count;
  }

  async tag(key: string, ...tags: string[]): Promise<void> {
    const storageKey = this.qualifyKey(key);
    this.trackTags(storageKey, tags);
    this.log(`[TAG] Tagged "${storageKey}" with: ${tags.join(", ")}`);
  }

  private trackTags(key: string, tags: string[]): void {
    if (!this.keyTags.has(key)) this.keyTags.set(key, new Set());
    for (const tag of tags) {
      if (!this.tags.has(tag)) this.tags.set(tag, new Set());
      this.tags.get(tag)!.add(key);
      this.keyTags.get(key)!.add(tag);
    }
  }

  async warm(entries: Array<{ key: string; value: unknown; ttlMs?: number }>): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.ttlMs ?? 60_000);
    }
    this.log(`[WARM] Warmed ${entries.length} keys`);
  }

  getGeneration(): number | undefined {
    return this.generation;
  }

  bumpGeneration(nextGeneration = (this.generation ?? 0) + 1): number {
    this.generation = nextGeneration;
    this.log(`[GENERATION] Active generation is now v${nextGeneration}`);
    return nextGeneration;
  }

  getStats() {
    return { ...this.stats, layerSizes: this.layers.map((l) => ({ name: l.name, size: l.size() })) };
  }

  getLayerInfo() {
    return this.layers.map((l) => ({ name: l.name, latencyMs: l.latencyMs, size: l.size(), keys: l.keys() }));
  }

  private log(message: string) {
    this.onLog?.(message);
  }

  private qualifyKey(key: string): string {
    return this.generation === undefined ? key : `v${this.generation}:${key}`;
  }

  private async backfillUpperLayers<T>(
    key: string,
    value: T,
    operation: ReturnType<typeof resolveOperationOptions>,
    hitIndex: number
  ): Promise<void> {
    const upperLayers = this.layers.slice(0, hitIndex);
    await Promise.all(upperLayers.map((layer) => layer.set(key, value, operation.ttlMs, operation.staleWhileRevalidateMs)));
    this.stats.backfills += upperLayers.length;
    this.log(`[BACKFILL] Filled ${upperLayers.length} upper layer(s) for "${key}" in parallel`);
  }

  private async fetchAndStore<T>(
    storageKey: string,
    userKey: string,
    fetcher: (context: { key: string; currentValue: T | undefined; state: "miss" }) => Promise<T>,
    operation: ReturnType<typeof resolveOperationOptions>
  ): Promise<T | null> {
    const existing = this.inFlight.get(storageKey);
    if (existing) {
      this.log(`[STAMPEDE-PREVENT] Deduplicating request for "${storageKey}"`);
      return existing as Promise<T | null>;
    }

    this.log(`[FETCH] Calling fetcher for "${storageKey}"...`);
    const fetchPromise = (async () => {
      try {
        const value = await fetcher({ key: userKey, currentValue: undefined, state: "miss" });
        if (value !== null && value !== undefined && operation.shouldCache?.(value) !== false) {
          await this.storeInLayers(storageKey, value, operation);
          this.stats.backfills++;
          this.log(`[BACKFILL] Stored "${storageKey}" in all layers`);
        }
        return value;
      } finally {
        this.inFlight.delete(storageKey);
      }
    })();

    this.inFlight.set(storageKey, fetchPromise);
    return fetchPromise as Promise<T | null>;
  }

  private refreshStale<T>(
    storageKey: string,
    userKey: string,
    currentValue: T,
    fetcher: (context: { key: string; currentValue: T | undefined; state: "stale-while-revalidate" }) => Promise<T>,
    operation: ReturnType<typeof resolveOperationOptions>
  ) {
    if (this.inFlight.has(storageKey)) {
      this.log(`[SWR] Refresh already in progress for "${storageKey}"`);
      return;
    }

    this.log(`[SWR] Serving stale "${storageKey}" while refreshing in background`);
    this.stats.refreshes++;

    const refreshPromise = (async () => {
      try {
        const value = await fetcher({ key: userKey, currentValue, state: "stale-while-revalidate" });
        if (value !== null && value !== undefined && operation.shouldCache?.(value) !== false) {
          await this.storeInLayers(storageKey, value, operation);
          this.stats.backfills++;
          this.log(`[SWR] Refreshed "${storageKey}" in all layers`);
        }
      } catch (error) {
        this.log(`[SWR] Refresh failed for "${storageKey}": ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.inFlight.delete(storageKey);
      }
    })();

    this.inFlight.set(storageKey, refreshPromise);
  }
}

// Factory function to create a typical setup
export function createPlaygroundCache(optionsOrLog?: PlaygroundCacheOptions | ((message: string) => void)) {
  const options = typeof optionsOrLog === "function" ? { onLog: optionsOrLog } : optionsOrLog;
  const memory = new MockCacheLayer("Memory", 1);
  const redis = new MockCacheLayer("Redis", 5);
  const disk = new MockCacheLayer("Disk", 20);
  const cache = new MockCacheStack([memory, redis, disk], options);
  return { cache, layers: { memory, redis, disk } };
}
