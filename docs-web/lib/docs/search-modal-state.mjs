/**
 * @param {number} currentIndex
 * @param {number} delta
 * @param {number} resultCount
 * @returns {number}
 */
export function getNextSelectedIndex(currentIndex, delta, resultCount) {
  if (resultCount <= 0) {
    return 0;
  }

  return Math.min(Math.max(currentIndex + delta, 0), resultCount - 1);
}

/**
 * @param {{ isOpen: boolean; latestRequestId: number; requestId: number }} params
 * @returns {boolean}
 */
export function shouldApplySearchResponse({
  isOpen,
  latestRequestId,
  requestId,
}) {
  return isOpen && latestRequestId === requestId;
}
