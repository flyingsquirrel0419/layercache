/** Maximum number of characters shown for a cache key in log/error messages. */
export const KEY_DISPLAY_LENGTH = 64

/**
 * Returns a display-safe representation of a cache key.
 * Keys longer than {@link KEY_DISPLAY_LENGTH} characters are truncated
 * and suffixed with `"..."`.
 *
 * Every module that renders a key in a user-facing message (errors, logs,
 * debug output) should use this helper so the format stays consistent.
 */
export function displayKey(key: string): string {
  return key.length > KEY_DISPLAY_LENGTH ? `${key.slice(0, KEY_DISPLAY_LENGTH)}...` : key
}
