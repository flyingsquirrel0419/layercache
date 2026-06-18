import { describe, expect, it } from 'vitest'
import { blockedPlaygroundWorkerGlobals, createPlaygroundSandbox } from '../../docs-web/lib/playground/worker-sandbox'

describe('playground worker sandbox', () => {
  it('shadows direct access to dangerous Worker globals', () => {
    const { sandbox } = createPlaygroundSandbox(() => undefined)

    for (const name of blockedPlaygroundWorkerGlobals) {
      expect(sandbox).toHaveProperty(name, undefined)
    }

    const checkGlobals = new Function(
      ...Object.keys(sandbox),
      `return {
        self: typeof self,
        globalThis: typeof globalThis,
        fetch: typeof fetch,
        postMessage: typeof postMessage,
        Function: typeof Function,
        eval: typeof eval
      }`
    )

    expect(checkGlobals(...Object.values(sandbox))).toEqual({
      self: 'undefined',
      globalThis: 'undefined',
      fetch: 'undefined',
      postMessage: 'undefined',
      Function: 'undefined',
      eval: 'undefined'
    })
  })
})
