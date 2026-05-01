import test from "node:test";
import assert from "node:assert/strict";
import { createReportingCacheState } from "../lib/playground/reporting-cache-state.mjs";

test("returns the initial cache when no playground cache factory is called", () => {
  const initialCache = { name: "initial" };
  const state = createReportingCacheState(initialCache);

  assert.equal(state.getActiveCache(), initialCache);
});

test("reports the most recently created cache instance", () => {
  const initialCache = { name: "initial" };
  const latestCache = { name: "latest" };
  const state = createReportingCacheState(initialCache);

  state.track(latestCache);

  assert.equal(state.getActiveCache(), latestCache);
});
