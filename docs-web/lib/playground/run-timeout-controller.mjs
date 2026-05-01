export const RUN_TIMEOUT_MS = 30000;

export function clearRunTimeout(timeoutRef, clearTimer = clearTimeout) {
  if (timeoutRef.current === null) {
    return;
  }

  clearTimer(timeoutRef.current);
  timeoutRef.current = null;
}

export function armRunTimeout({
  timeoutRef,
  onTimeout,
  ms = RUN_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  clearRunTimeout(timeoutRef, clearTimer);

  const timerId = setTimer(() => {
    timeoutRef.current = null;
    onTimeout();
  }, ms);

  timeoutRef.current = timerId;
  return timerId;
}
