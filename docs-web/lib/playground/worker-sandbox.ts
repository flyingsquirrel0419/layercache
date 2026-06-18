import { createPlaygroundCache } from "./mock-layers";

type PlaygroundLogType = "log" | "error" | "cache";
type PlaygroundPostLog = (type: PlaygroundLogType, message: string) => void;

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

export function createPlaygroundSandbox(postLog: PlaygroundPostLog) {
  const { cache } = createPlaygroundCache((message: string) => {
    postLog("cache", message);
  });
  let activeCache = cache;

  const blockedGlobals = Object.fromEntries(blockedPlaygroundWorkerGlobals.map((name) => [name, undefined]));

  const sandbox = {
    cache,
    createPlaygroundCache: (options = {}) => {
      const instance = createPlaygroundCache({
        ...options,
        onLog: (msg: string) => postLog("cache", msg),
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
