// Simple in-memory cache layer mock
export class MockCacheLayer {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  readonly name: string;
  readonly latencyMs: number;

  constructor(name: string, latencyMs: number) {
    this.name = name;
    this.latencyMs = latencyMs;
  }

  async get(key: string): Promise<unknown> {
    await this.simulateLatency();
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.simulateLatency();
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<boolean> {
    await this.simulateLatency();
    return this.store.delete(key);
  }

  async clear(): Promise<void> {
    await this.simulateLatency();
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  keys(): string[] {
    return Array.from(this.store.keys());
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
  private stats = { hits: 0, misses: 0, sets: 0, deletes: 0, backfills: 0 };
  private inFlight = new Map<string, Promise<unknown>>();
  private onLog?: (message: string) => void;

  constructor(layers: MockCacheLayer[], options?: { onLog?: (message: string) => void }) {
    this.layers = layers;
    this.onLog = options?.onLog;
  }

  async get<T>(key: string, fetcher?: () => Promise<T>, ttlSeconds = 60): Promise<T | undefined> {
    // Try each layer
    for (const layer of this.layers) {
      const value = await layer.get(key);
      if (value !== undefined) {
        this.stats.hits++;
        this.log(`[${layer.name}] HIT for key "${key}"`);
        return value as T;
      }
    }

    this.stats.misses++;
    this.log(`[MISS] Key "${key}" not found in any layer`);

    // Stampede prevention: reuse in-flight fetcher for same key
    if (fetcher) {
      const existing = this.inFlight.get(key);
      if (existing) {
        this.log(`[STAMPEDE-PREVENT] Deduplicating request for "${key}"`);
        return existing as Promise<T>;
      }

      this.log(`[FETCH] Calling fetcher for "${key}"...`);
      const fetchPromise = (async () => {
        try {
          const value = await fetcher();
          if (value !== undefined) {
            await this.set(key, value, ttlSeconds);
            this.stats.backfills++;
            this.log(`[BACKFILL] Stored "${key}" in all layers`);
          }
          return value;
        } finally {
          this.inFlight.delete(key);
        }
      })();

      this.inFlight.set(key, fetchPromise);
      return fetchPromise as Promise<T>;
    }

    return undefined;
  }

  async set<T>(key: string, value: T, ttlSeconds = 60): Promise<void> {
    this.stats.sets++;
    for (const layer of this.layers) {
      await layer.set(key, value, ttlSeconds);
    }
    this.log(`[SET] Stored "${key}" in ${this.layers.length} layers`);
  }

  async delete(key: string): Promise<void> {
    this.stats.deletes++;
    for (const layer of this.layers) {
      await layer.delete(key);
    }
    // Clean up tags
    const keyTagSet = this.keyTags.get(key);
    if (keyTagSet) {
      for (const tag of keyTagSet) {
        this.tags.get(tag)?.delete(key);
      }
      this.keyTags.delete(key);
    }
    this.log(`[DELETE] Removed "${key}" from all layers`);
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
    if (!this.keyTags.has(key)) this.keyTags.set(key, new Set());
    for (const tag of tags) {
      if (!this.tags.has(tag)) this.tags.set(tag, new Set());
      this.tags.get(tag)!.add(key);
      this.keyTags.get(key)!.add(tag);
    }
    this.log(`[TAG] Tagged "${key}" with: ${tags.join(", ")}`);
  }

  async warm(entries: Array<{ key: string; value: unknown; ttlSeconds?: number }>): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.ttlSeconds ?? 60);
    }
    this.log(`[WARM] Warmed ${entries.length} keys`);
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
}

// Factory function to create a typical setup
export function createPlaygroundCache(onLog?: (message: string) => void) {
  const memory = new MockCacheLayer("Memory", 1);
  const redis = new MockCacheLayer("Redis", 5);
  const disk = new MockCacheLayer("Disk", 20);
  const cache = new MockCacheStack([memory, redis, disk], { onLog });
  return { cache, layers: { memory, redis, disk } };
}
