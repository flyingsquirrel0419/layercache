export class PatternMatcher {
  static matches(pattern: string, value: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    return regex.test(value)
  }
}
