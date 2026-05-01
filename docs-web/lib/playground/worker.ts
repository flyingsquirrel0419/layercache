// Web Worker for playground execution
import { createPlaygroundCache } from "./mock-layers";

const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent) => {
  const { type, code } = event.data;

  if (type === "run") {
    const startTime = Date.now();

    const postLog = (type: "log" | "error" | "cache", message: string) => {
      const timestamp = Date.now();
      ctx.postMessage({ type, message, timestamp });
    };

    // Capture console
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
      postLog("log", message);
    };
    console.error = (...args: unknown[]) => {
      const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
      postLog("error", message);
    };

    try {
      const { cache } = createPlaygroundCache((message: string) => {
        postLog("cache", message);
      });
      let activeCache = cache;

      const sandbox = {
        cache,
        createPlaygroundCache: () => {
          const instance = createPlaygroundCache((msg: string) => postLog("cache", msg));
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
      };

      const asyncFn = new Function(
        ...Object.keys(sandbox),
        `return (async () => {\n${code}\n})();`
      );

      await asyncFn(...Object.values(sandbox));

      ctx.postMessage({
        type: "done",
        layerInfo: activeCache.getLayerInfo(),
        stats: activeCache.getStats(),
      });
    } catch (error) {
      postLog("error", error instanceof Error ? error.message : String(error));
      ctx.postMessage({ type: "done", layerInfo: undefined, stats: undefined });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }
};
