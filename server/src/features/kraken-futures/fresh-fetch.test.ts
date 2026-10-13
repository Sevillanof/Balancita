import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { freshConnectionFetch } from './fresh-fetch.ts'

let server: Server | undefined
afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  )
  server = undefined
})

function listen(handler?: Parameters<typeof createServer>[1]) {
  const sockets = new Set<Socket>()
  server = createServer(
    handler ?? ((_, response) => response.end('{"ok":true}')),
  )
  server.keepAliveTimeout = 5_000
  server.on('connection', (socket) => sockets.add(socket))
  return new Promise<{ url: string; sockets: Set<Socket> }>((resolve) =>
    server!.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`,
        sockets,
      }),
    ),
  )
}

describe('fresh connection transport', () => {
  it('opens its own connection per request, never touching the global fetch pool', async () => {
    const { url, sockets } = await listen()
    await (await fetch(url)).text()
    const pooled = sockets.size
    expect(pooled).toBeGreaterThanOrEqual(1)
    await (await freshConnectionFetch(url)).text()
    await (await freshConnectionFetch(url)).text()
    // Each fresh request added exactly one new connection, even with a pooled one idle to the same host.
    expect(sockets.size).toBe(pooled + 2)
    const [, ...fresh] = [...sockets]
    await new Promise((resolve) => setTimeout(resolve, 50))
    // And closed it when the response ended (Connection: close).
    expect(fresh.slice(-2).every((socket) => socket.destroyed)).toBe(true)
  })

  it('returns status, headers and body like fetch', async () => {
    const { url } = await listen((_, response) => {
      response.writeHead(429, { 'x-test': 'yes' })
      response.end('slow down')
    })
    const response = await freshConnectionFetch(url)
    expect(response.status).toBe(429)
    expect(response.headers.get('x-test')).toBe('yes')
    expect(await response.text()).toBe('slow down')
  })

  it('is abortable, so a hung request is released by the poll deadline', async () => {
    const { url } = await listen(() => undefined) // never answers
    const controller = new AbortController()
    const pending = freshConnectionFetch(url, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toThrow()
  })

  it('refuses a body above the bound', async () => {
    const { url } = await listen((_, response) => {
      response.write(Buffer.alloc(9 * 1024 * 1024))
      response.end()
    })
    await expect(freshConnectionFetch(url)).rejects.toThrow()
  })
})
