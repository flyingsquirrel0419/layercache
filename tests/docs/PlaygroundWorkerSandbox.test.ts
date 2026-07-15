import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createPlaygroundWorkerSource } from '../../docs-web/lib/playground/runner-source'
import {
  PLAYGROUND_IFRAME_SANDBOX,
  createPlaygroundFrameSource,
  isTrustedPlaygroundWorkerMessage
} from '../../docs-web/lib/playground/sandboxed-runner'

function createWorkerContext() {
  const outboundMessages: Array<Record<string, unknown>> = []
  const baseContext = {
    console: {
      log: () => undefined,
      error: () => undefined
    },
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
    postMessage: (message: Record<string, unknown>) => outboundMessages.push(message),
    fetch: () => Promise.resolve(),
    onmessage: undefined as undefined | ((event: { data: Record<string, unknown> }) => Promise<void>)
  }
  const context = vm.createContext(baseContext)
  context.self = context
  context.globalThis = context

  return {
    outboundMessages,
    context
  }
}

describe('playground sandbox runner', () => {
  it('uses an opaque-origin iframe sandbox with a restrictive CSP', () => {
    expect(PLAYGROUND_IFRAME_SANDBOX).toBe('allow-scripts')
    expect(PLAYGROUND_IFRAME_SANDBOX).not.toContain('allow-same-origin')

    const frameSource = createPlaygroundFrameSource()
    expect(frameSource).toContain("default-src 'none'")
    expect(frameSource).toContain("'unsafe-eval'")
    expect(frameSource).toContain('connect-src')
    expect(frameSource).toContain('worker-src blob:')
  })

  it('filters forged worker messages that do not include the runner token', async () => {
    const { context, outboundMessages } = createWorkerContext()
    vm.runInContext(createPlaygroundWorkerSource(), context)

    await context.onmessage?.({
      data: {
        type: 'run',
        runId: 'run-1',
        messageToken: 'trusted-token',
        code: `
          const realPostMessage = console.log.constructor('return postMessage')();
          realPostMessage({ type: 'done', runId: 'run-1', layerInfo: [{ forged: true }] });
          console.log('continued');
        `
      }
    })

    expect(outboundMessages).toContainEqual({
      type: 'done',
      runId: 'run-1',
      layerInfo: [{ forged: true }]
    })

    const trustedMessages = outboundMessages.filter((message) =>
      isTrustedPlaygroundWorkerMessage(message, 'trusted-token')
    )

    expect(trustedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'log',
          message: 'continued',
          runId: 'run-1',
          messageToken: 'trusted-token'
        }),
        expect.objectContaining({
          type: 'done',
          runId: 'run-1',
          messageToken: 'trusted-token'
        })
      ])
    )
    expect(trustedMessages).not.toContainEqual(
      expect.objectContaining({
        layerInfo: [{ forged: true }]
      })
    )
  })

  it('does not let sandbox code replace the trusted sender and steal the runner token', async () => {
    const { context, outboundMessages } = createWorkerContext()
    vm.runInContext(createPlaygroundWorkerSource(), context)

    await context.onmessage?.({
      data: {
        type: 'run',
        runId: 'run-1',
        messageToken: 'trusted-token',
        code: `
          const realGlobal = console.log.constructor('return globalThis')();
          const originalSend = realGlobal.send;
          realGlobal.send = (token, message) => {
            realGlobal.postMessage({
              type: 'done',
              runId: message.runId,
              messageToken: token,
              layerInfo: [{ forged: true }],
              stats: {}
            });
          };
          console.log('capture');
          realGlobal.send = originalSend;
        `
      }
    })

    const trustedMessages = outboundMessages.filter((message) =>
      isTrustedPlaygroundWorkerMessage(message, 'trusted-token')
    )
    expect(trustedMessages).not.toContainEqual(
      expect.objectContaining({
        layerInfo: [{ forged: true }]
      })
    )
    expect(trustedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'log', message: 'capture' }),
        expect.objectContaining({ type: 'done' })
      ])
    )
  })
})
