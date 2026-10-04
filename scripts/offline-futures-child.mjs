import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildApp } from '../server/src/app/app.ts'
import { serverConfigFrom } from '../server/src/platform/config.ts'

let socket
let app
let activeTimestamp
process.on('message', async (message) => {
  try {
    if (message.type === 'start') {
      activeTimestamp = Date.parse(message.activeTimestamp)
      class ReplaySocket {
        onopen = null
        onmessage = null
        onerror = null
        onclose = null
        constructor() {
          socket = this
          queueMicrotask(() => this.onopen?.())
        }
        send() {}
        close() {
          this.onclose?.()
        }
      }
      mkdirSync(message.temp, { recursive: true })
      app = await buildApp({
        config: serverConfigFrom({
          FUTURES_MODE: 'paper_live',
          FUTURES_DB_PATH: join(message.temp, 'account.sqlite'),
          FUTURES_MARKET_DB_PATH: join(message.temp, 'market.sqlite'),
          KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
        }),
        overrides: {
          futuresPublicCatalog: async () => message.catalog,
          futuresSocketFactory: () => new ReplaySocket(),
          futuresFundingFetch: async () =>
            new Response(message.funding.raw, {
              status: message.funding.status,
              headers: message.funding.headers,
            }),
          futuresClock: () => activeTimestamp,
        },
      })
      await app.ready()
      process.send?.({ type: 'ready', pid: process.pid })
    } else if (message.type === 'frame') {
      activeTimestamp = Date.parse(message.timestamp)
      socket?.onmessage?.({ data: message.raw })
      process.send?.({ type: 'delivered', id: message.id })
    } else if (message.type === 'finish') {
      await app?.close()
      process.send?.({ type: 'closed' })
      process.disconnect()
    }
  } catch (error) {
    process.send?.({
      type: 'error',
      error: error instanceof Error ? error.stack : String(error),
    })
  }
})
