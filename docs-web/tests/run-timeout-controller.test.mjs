import test from "node:test";
import assert from "node:assert/strict";
import {
  RUN_TIMEOUT_MS,
  armRunTimeout,
  clearRunTimeout,
} from "../lib/playground/run-timeout-controller.mjs";

test("clearRunTimeout clears the active timer and resets the ref", () => {
  const timeoutRef = { current: "timer-1" };
  const cleared = [];

  clearRunTimeout(timeoutRef, (timerId) => {
    cleared.push(timerId);
  });

  assert.deepEqual(cleared, ["timer-1"]);
  assert.equal(timeoutRef.current, null);
});

test("armRunTimeout clears an existing timer before scheduling a new one", () => {
  const timeoutRef = { current: "timer-1" };
  const cleared = [];
  const scheduled = [];

  const timerId = armRunTimeout({
    timeoutRef,
    onTimeout: () => {},
    setTimer: (callback, ms) => {
      scheduled.push({ callback, ms });
      return "timer-2";
    },
    clearTimer: (existingTimerId) => {
      cleared.push(existingTimerId);
    },
  });

  assert.equal(timerId, "timer-2");
  assert.deepEqual(cleared, ["timer-1"]);
  assert.equal(scheduled[0]?.ms, RUN_TIMEOUT_MS);
  assert.equal(timeoutRef.current, "timer-2");
});

test("armRunTimeout resets the ref before invoking the timeout callback", () => {
  const timeoutRef = { current: null };
  const states = [];
  let scheduledCallback;

  armRunTimeout({
    timeoutRef,
    onTimeout: () => {
      states.push(timeoutRef.current);
    },
    setTimer: (callback) => {
      scheduledCallback = callback;
      return "timer-3";
    },
    clearTimer: () => {},
  });

  assert.equal(timeoutRef.current, "timer-3");
  scheduledCallback();

  assert.deepEqual(states, [null]);
  assert.equal(timeoutRef.current, null);
});
