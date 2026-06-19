export const blockedPlaygroundWorkerGlobals = [
  "self",
  "globalThis",
  "fetch",
  "postMessage",
  "importScripts",
  "Worker",
  "XMLHttpRequest",
  "Function",
  "eval",
] as const;

export type PlaygroundWorkerMessage = {
  type?: unknown;
  messageToken?: unknown;
};

export function isTrustedPlaygroundWorkerMessage(
  message: PlaygroundWorkerMessage,
  messageToken: string
): boolean {
  return message.messageToken === messageToken;
}

export function createPlaygroundWorkerSource(): string {
  return `
const blockedPlaygroundWorkerGlobals = ${JSON.stringify(blockedPlaygroundWorkerGlobals)};
const originalPostMessage = self.postMessage.bind(self);

function send(messageToken, message) {
  originalPostMessage({ ...message, messageToken });
}

const DEFAULT_TTL_MS = 60000;

function resolveOperationOptions(options = DEFAULT_TTL_MS) {
  if (typeof options === "number") {
    return {
      ttlMs: options,
      staleWhileRevalidateMs: 0,
      tags: undefined,
      negativeCache: false,
      cacheNullValues: false,
      circuitBreaker: undefined,
      shouldCache: undefined,
    };
  }

  return {
    ttlMs: options.ttl ?? DEFAULT_TTL_MS,
    staleWhileRevalidateMs: options.staleWhileRevalidate ?? 0,
    tags: options.tags,
    negativeCache: options.negativeCache ?? false,
    cacheNullValues: options.cacheNullValues ?? false,
    circuitBreaker: options.circuitBreaker,
    shouldCache: options.shouldCache,
  };
}

class MockCacheLayer {
  constructor(name, latencyMs) {
    this.store = new Map();
    this.name = name;
    this.latencyMs = latencyMs;
  }

  async get(key) {
    const entry = await this.getEntry(key);
    return entry?.state === "fresh" ? entry.value : undefined;
  }

  async getEntry(key) {
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
      kind: entry.kind,
      state: now > entry.freshUntil ? "stale-while-revalidate" : "fresh",
    };
  }

  async set(key, value, ttlMs, staleWhileRevalidateMs = 0, kind = "value") {
    await this.simulateLatency();
    const freshUntil = Date.now() + ttlMs;
    this.store.set(key, { value, kind, freshUntil, expiresAt: freshUntil + staleWhileRevalidateMs });
  }

  async delete(key) {
    await this.simulateLatency();
    return this.store.delete(key);
  }

  async expire(key) {
    await this.simulateLatency();
    const entry = this.store.get(key);
    if (!entry) return false;

    this.store.set(key, { ...entry, freshUntil: Date.now() - 1 });
    return true;
  }

  async clear() {
    await this.simulateLatency();
    this.store.clear();
  }

  size() {
    this.pruneExpired();
    return this.store.size;
  }

  keys() {
    this.pruneExpired();
    return Array.from(this.store.keys());
  }

  pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  simulateLatency() {
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

class MockCacheStack {
  constructor(layers, options) {
    this.layers = layers;
    this.tags = new Map();
    this.keyTags = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      backfills: 0,
      staleHits: 0,
      refreshes: 0,
      negativeCacheHits: 0,
      circuitBreakerTrips: 0,
    };
    this.inFlight = new Map();
    this.circuitBreakers = new Map();
    this.generation = options?.generation;
    this.onLog = options?.onLog;
  }

  async get(key, fetcher, options = DEFAULT_TTL_MS) {
    const operation = resolveOperationOptions(options);
    const storageKey = this.qualifyKey(key);

    for (const [index, layer] of this.layers.entries()) {
      const entry = await layer.getEntry(storageKey);
      if (entry) {
        this.stats.hits++;
        if (entry.kind === "empty") {
          this.stats.negativeCacheHits++;
          this.log("[" + layer.name + "] NEGATIVE HIT for key \\"" + storageKey + "\\"");
          return null;
        }
        if (entry.state === "stale-while-revalidate") {
          this.stats.staleHits++;
          this.log("[" + layer.name + "] STALE for key \\"" + storageKey + "\\"");
          if (fetcher) {
            this.refreshStale(storageKey, key, entry.value, fetcher, operation);
          }
        } else {
          this.log("[" + layer.name + "] HIT for key \\"" + storageKey + "\\"");
        }
        if (index > 0) {
          await this.backfillUpperLayers(storageKey, entry.value, operation, index);
        }
        return entry.value;
      }
    }

    this.stats.misses++;
    this.log("[MISS] Key \\"" + storageKey + "\\" not found in any layer");

    if (fetcher) {
      return this.fetchAndStore(storageKey, key, fetcher, operation);
    }

    return null;
  }

  async getEntry(key) {
    const storageKey = this.qualifyKey(key);

    for (const [index, layer] of this.layers.entries()) {
      const entry = await layer.getEntry(storageKey);
      if (!entry) continue;

      if (index > 0) {
        await this.backfillUpperLayers(storageKey, entry.value, resolveOperationOptions(), index, entry.kind);
      }

      return {
        key,
        value: entry.value,
        kind: entry.kind,
        state: entry.state === "fresh" ? "fresh" : "stale",
        layer: layer.name,
      };
    }

    return null;
  }

  async set(key, value, options = DEFAULT_TTL_MS) {
    const operation = resolveOperationOptions(options);
    await this.storeInLayers(this.qualifyKey(key), value, operation);
  }

  async storeInLayers(key, value, operation, kind = "value") {
    this.stats.sets++;
    await Promise.all(
      this.layers.map((layer) => layer.set(key, value, operation.ttlMs, operation.staleWhileRevalidateMs, kind))
    );
    if (operation.tags) {
      this.trackTags(key, operation.tags);
    }
    this.log("[SET] Stored \\"" + key + "\\" in " + this.layers.length + " layers");
  }

  async delete(key) {
    const storageKey = this.qualifyKey(key);
    this.stats.deletes++;
    await Promise.all(this.layers.map((layer) => layer.delete(storageKey)));
    const keyTagSet = this.keyTags.get(storageKey);
    if (keyTagSet) {
      for (const tag of keyTagSet) {
        this.tags.get(tag)?.delete(storageKey);
      }
      this.keyTags.delete(storageKey);
    }
    this.log("[DELETE] Removed \\"" + storageKey + "\\" from all layers");
  }

  async invalidateByKey(key) {
    await this.delete(key);
  }

  async invalidateByKeys(keys) {
    for (const key of keys) {
      await this.delete(key);
    }
  }

  async expireByKey(key) {
    const storageKey = this.qualifyKey(key);
    await Promise.all(this.layers.map((layer) => layer.expire(storageKey)));
    this.log("[EXPIRE] Marked \\"" + storageKey + "\\" stale in all layers");
  }

  async expireByKeys(keys) {
    for (const key of keys) {
      await this.expireByKey(key);
    }
  }

  async invalidateByTag(tag) {
    const keys = this.tags.get(tag);
    if (!keys || keys.size === 0) return 0;
    const count = keys.size;
    for (const key of keys) {
      await this.delete(key);
    }
    this.log("[INVALIDATE] Removed " + count + " keys with tag \\"" + tag + "\\"");
    return count;
  }

  async tag(key, ...tags) {
    const storageKey = this.qualifyKey(key);
    this.trackTags(storageKey, tags);
    this.log("[TAG] Tagged \\"" + storageKey + "\\" with: " + tags.join(", "));
  }

  trackTags(key, tags) {
    if (!this.keyTags.has(key)) this.keyTags.set(key, new Set());
    for (const tag of tags) {
      if (!this.tags.has(tag)) this.tags.set(tag, new Set());
      this.tags.get(tag).add(key);
      this.keyTags.get(key).add(tag);
    }
  }

  async warm(entries) {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.ttlMs ?? 60000);
    }
    this.log("[WARM] Warmed " + entries.length + " keys");
  }

  getGeneration() {
    return this.generation;
  }

  bumpGeneration(nextGeneration = (this.generation ?? 0) + 1) {
    this.generation = nextGeneration;
    this.log("[GENERATION] Active generation is now v" + nextGeneration);
    return nextGeneration;
  }

  getStats() {
    return { ...this.stats, layerSizes: this.layers.map((l) => ({ name: l.name, size: l.size() })) };
  }

  getLayerInfo() {
    return this.layers.map((l) => ({ name: l.name, latencyMs: l.latencyMs, size: l.size(), keys: l.keys() }));
  }

  log(message) {
    this.onLog?.(message);
  }

  qualifyKey(key) {
    return this.generation === undefined ? key : "v" + this.generation + ":" + key;
  }

  async backfillUpperLayers(key, value, operation, hitIndex, kind = "value") {
    const upperLayers = this.layers.slice(0, hitIndex);
    await Promise.all(
      upperLayers.map((layer) => layer.set(key, value, operation.ttlMs, operation.staleWhileRevalidateMs, kind))
    );
    this.stats.backfills += upperLayers.length;
    this.log("[BACKFILL] Filled " + upperLayers.length + " upper layer(s) for \\"" + key + "\\" in parallel");
  }

  async fetchAndStore(storageKey, userKey, fetcher, operation) {
    const existing = this.inFlight.get(storageKey);
    if (existing) {
      this.log("[STAMPEDE-PREVENT] Deduplicating request for \\"" + storageKey + "\\"");
      return existing;
    }

    this.log("[FETCH] Calling fetcher for \\"" + storageKey + "\\"...");
    const fetchPromise = (async () => {
      const breakerKey = this.resolveCircuitBreakerKey(storageKey, operation.circuitBreaker);

      try {
        this.assertCircuitClosed(breakerKey);
        const value = await fetcher({ key: userKey, currentValue: undefined, state: "miss" });
        this.circuitBreakers.delete(breakerKey);
        const shouldStoreNull = value === null && (operation.cacheNullValues || operation.negativeCache);
        const shouldStoreValue = value !== undefined && (value !== null || shouldStoreNull);
        if (shouldStoreValue && operation.shouldCache?.(value) !== false) {
          const kind = value === null && operation.negativeCache && !operation.cacheNullValues ? "empty" : "value";
          await this.storeInLayers(storageKey, value, operation, kind);
          this.stats.backfills++;
          this.log("[BACKFILL] Stored \\"" + storageKey + "\\" in all layers");
        }
        return value;
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith("Circuit breaker is open"))) {
          this.recordCircuitFailure(breakerKey, operation.circuitBreaker);
        }
        throw error;
      } finally {
        this.inFlight.delete(storageKey);
      }
    })();

    this.inFlight.set(storageKey, fetchPromise);
    return fetchPromise;
  }

  refreshStale(storageKey, userKey, currentValue, fetcher, operation) {
    if (this.inFlight.has(storageKey)) {
      this.log("[SWR] Refresh already in progress for \\"" + storageKey + "\\"");
      return;
    }

    this.log("[SWR] Serving stale \\"" + storageKey + "\\" while refreshing in background");
    this.stats.refreshes++;

    const refreshPromise = (async () => {
      const breakerKey = this.resolveCircuitBreakerKey(storageKey, operation.circuitBreaker);

      try {
        this.assertCircuitClosed(breakerKey);
        const value = await fetcher({ key: userKey, currentValue, state: "stale-while-revalidate" });
        this.circuitBreakers.delete(breakerKey);
        const shouldStoreNull = value === null && (operation.cacheNullValues || operation.negativeCache);
        const shouldStoreValue = value !== undefined && (value !== null || shouldStoreNull);
        if (shouldStoreValue && operation.shouldCache?.(value) !== false) {
          const kind = value === null && operation.negativeCache && !operation.cacheNullValues ? "empty" : "value";
          await this.storeInLayers(storageKey, value, operation, kind);
          this.stats.backfills++;
          this.log("[SWR] Refreshed \\"" + storageKey + "\\" in all layers");
        }
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith("Circuit breaker is open"))) {
          this.recordCircuitFailure(breakerKey, operation.circuitBreaker);
        }
        this.log("[SWR] Refresh failed for \\"" + storageKey + "\\": " + (error instanceof Error ? error.message : String(error)));
      } finally {
        this.inFlight.delete(storageKey);
      }
    })();

    this.inFlight.set(storageKey, refreshPromise);
  }

  resolveCircuitBreakerKey(key, options) {
    if (!options) return "key:" + key;
    if (options.breakerKey) return "custom:" + options.breakerKey;
    if (options.scope === "shared") return "scope:shared";
    return "key:" + key;
  }

  assertCircuitClosed(breakerKey) {
    const state = this.circuitBreakers.get(breakerKey);
    if (!state?.openUntil) return;
    if (state.openUntil <= Date.now()) {
      this.circuitBreakers.delete(breakerKey);
      return;
    }
    throw new Error("Circuit breaker is open for \\"" + breakerKey + "\\"");
  }

  recordCircuitFailure(breakerKey, options) {
    if (!options) return;
    const state = this.circuitBreakers.get(breakerKey) ?? { failures: 0, openUntil: null };
    state.failures += 1;
    if (state.failures >= (options.failureThreshold ?? 3)) {
      state.openUntil = Date.now() + (options.cooldownMs ?? 30000);
      this.stats.circuitBreakerTrips++;
      this.log("[CIRCUIT-BREAKER] Opened \\"" + breakerKey + "\\"");
    }
    this.circuitBreakers.set(breakerKey, state);
  }
}

function createPlaygroundCache(optionsOrLog) {
  const options = typeof optionsOrLog === "function" ? { onLog: optionsOrLog } : optionsOrLog;
  const memory = new MockCacheLayer("Memory", 1);
  const redis = new MockCacheLayer("Redis", 5);
  const disk = new MockCacheLayer("Disk", 20);
  const cache = new MockCacheStack([memory, redis, disk], options);
  return { cache, layers: { memory, redis, disk } };
}

function createPlaygroundSandbox(postLog) {
  const { cache } = createPlaygroundCache((message) => {
    postLog("cache", message);
  });
  let activeCache = cache;
  const blockedGlobals = Object.fromEntries(blockedPlaygroundWorkerGlobals.map((name) => [name, undefined]));

  const sandbox = {
    cache,
    createPlaygroundCache: (options = {}) => {
      const instance = createPlaygroundCache({
        ...options,
        onLog: (msg) => postLog("cache", msg),
      });
      activeCache = instance.cache;
      return instance;
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Date,
    Map,
    Set,
    Array,
    Object,
    Math,
    Error,
    TypeError,
    RangeError,
    ...blockedGlobals,
  };

  return {
    sandbox,
    getActiveCache: () => activeCache,
  };
}

self.onmessage = async (event) => {
  const { type, code, runId, messageToken } = event.data || {};
  if (type !== "run" || typeof code !== "string" || typeof runId !== "string" || typeof messageToken !== "string") {
    return;
  }

  const postLog = (type, message) => {
    send(messageToken, { type, message, timestamp: Date.now(), runId });
  };

  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    postLog("log", message);
  };
  console.error = (...args) => {
    const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    postLog("error", message);
  };

  try {
    const { sandbox, getActiveCache } = createPlaygroundSandbox(postLog);
    const asyncFn = new Function(
      ...Object.keys(sandbox),
      "return (async () => {\\n" + code + "\\n})();"
    );

    await asyncFn(...Object.values(sandbox));

    send(messageToken, {
      type: "done",
      layerInfo: getActiveCache().getLayerInfo(),
      stats: getActiveCache().getStats(),
      runId,
    });
  } catch (error) {
    postLog("error", error instanceof Error ? error.message : String(error));
    send(messageToken, { type: "done", layerInfo: undefined, stats: undefined, runId });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
};
`;
}
