import { type Server, type Socket, connect, createServer } from 'node:net'

export interface RedisLatencyProxy {
  port: number
  setLatencyMs: (latencyMs: number) => void
  close: () => Promise<void>
}

export async function startRedisLatencyProxy(targetPort: number): Promise<RedisLatencyProxy> {
  let latencyMs = 0
  const sockets = new Set<Socket>()

  const server = createServer((clientSocket) => {
    const upstreamSocket = connect({
      host: '127.0.0.1',
      port: targetPort
    })

    sockets.add(clientSocket)
    sockets.add(upstreamSocket)

    clientSocket.on('error', () => {})
    upstreamSocket.on('error', () => {})
    clientSocket.on('close', () => {
      sockets.delete(clientSocket)
      if (!upstreamSocket.destroyed) {
        upstreamSocket.destroy()
      }
    })
    upstreamSocket.on('close', () => {
      sockets.delete(upstreamSocket)
      if (!clientSocket.destroyed) {
        clientSocket.destroy()
      }
    })

    clientSocket.on('data', (chunk) => {
      setTimeout(() => {
        if (!upstreamSocket.destroyed) {
          upstreamSocket.write(chunk)
        }
      }, latencyMs / 2)
    })

    upstreamSocket.on('data', (chunk) => {
      setTimeout(() => {
        if (!clientSocket.destroyed) {
          clientSocket.write(chunk)
        }
      }, latencyMs / 2)
    })

    clientSocket.on('end', () => upstreamSocket.end())
    upstreamSocket.on('end', () => clientSocket.end())
  })

  await listen(server)

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Latency proxy failed to acquire a TCP port')
  }

  return {
    port: address.port,
    setLatencyMs(nextLatencyMs: number) {
      latencyMs = nextLatencyMs
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy()
      }

      await closeServer(server)
    }
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}
