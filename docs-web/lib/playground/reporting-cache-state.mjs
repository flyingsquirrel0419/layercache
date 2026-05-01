export function createReportingCacheState(initialCache) {
  let activeCache = initialCache;

  return {
    track(cache) {
      activeCache = cache;
      return cache;
    },
    getActiveCache() {
      return activeCache;
    },
  };
}
