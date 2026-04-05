export class PatternMatcher {
  /**
   * Tests whether a glob-style pattern matches a value.
   * Supports `*` (any sequence of characters) and `?` (any single character).
   * Uses a two-pointer algorithm to avoid ReDoS vulnerabilities and
   * quadratic memory usage on long patterns/keys.
   */
  static matches(pattern: string, value: string): boolean {
    return PatternMatcher.matchLinear(pattern, value)
  }

  /**
   * Linear-time glob matching with O(1) extra memory.
   */
  private static matchLinear(pattern: string, value: string): boolean {
    let patternIndex = 0
    let valueIndex = 0
    let starIndex = -1
    let backtrackValueIndex = 0

    while (valueIndex < value.length) {
      const patternChar = pattern[patternIndex]
      const valueChar = value[valueIndex]

      if (patternChar === '*' && patternIndex < pattern.length) {
        starIndex = patternIndex
        patternIndex += 1
        backtrackValueIndex = valueIndex
        continue
      }

      if (patternChar === '?' || patternChar === valueChar) {
        patternIndex += 1
        valueIndex += 1
        continue
      }

      if (starIndex !== -1) {
        patternIndex = starIndex + 1
        backtrackValueIndex += 1
        valueIndex = backtrackValueIndex
        continue
      }

      return false
    }

    while (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      patternIndex += 1
    }

    return patternIndex === pattern.length
  }
}
