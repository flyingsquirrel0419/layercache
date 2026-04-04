export class PatternMatcher {
  /**
   * Tests whether a glob-style pattern matches a value.
   * Supports `*` (any sequence of characters) and `?` (any single character).
   * Uses a linear-time algorithm to avoid ReDoS vulnerabilities.
   */
  static matches(pattern: string, value: string): boolean {
    return PatternMatcher.matchLinear(pattern, value)
  }

  /**
   * Linear-time glob matching using dynamic programming.
   * Avoids catastrophic backtracking that RegExp-based glob matching can cause.
   */
  private static matchLinear(pattern: string, value: string): boolean {
    const m = pattern.length
    const n = value.length
    // dp[i][j] = pattern[0..i-1] matches value[0..j-1]
    const dp: boolean[][] = Array.from({ length: m + 1 }, () => new Array<boolean>(n + 1).fill(false))

    dp[0]![0] = true

    // patterns that are only '*' can match empty string
    for (let i = 1; i <= m; i++) {
      if (pattern[i - 1] === '*') {
        dp[i]![0] = dp[i - 1]![0]!
      }
    }

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const pc = pattern[i - 1]!
        if (pc === '*') {
          // '*' matches zero characters (dp[i-1][j]) or one more character (dp[i][j-1])
          dp[i]![j] = dp[i - 1]![j]! || dp[i]![j - 1]!
        } else if (pc === '?' || pc === value[j - 1]) {
          dp[i]![j] = dp[i - 1]![j - 1]!
        }
      }
    }

    return dp[m]![n]!
  }
}
