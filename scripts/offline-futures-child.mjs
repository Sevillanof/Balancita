import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildApp } from '../server/src/app/app.ts'
import { serverConfigFrom } from '../server/src/platform/config.ts'

let socket
let app
let activeTimestamp
let closeSourceState = null
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
      const workerTracePath = join(message.temp, 'worker-observer.jsonl')
      const replayDriverTracePath = join(message.temp, 'driver-trace.jsonl')
      const sqliteTracePath = join(message.temp, 'sqlite-observer.jsonl')
      const sourceQueueTracePath = join(message.temp, 'app-source-queue.jsonl')
      const closePhasesTracePath = join(message.temp, 'app-close-phases.jsonl')
      const pythonDiagnosticsPath = join(
        message.temp,
        'python-diagnostics.jsonl',
      )
      process.env.BALANCITA_FUTURES_DIAGNOSTICS_PATH = pythonDiagnosticsPath
      process.env.BALANCITA_WORKER_EVENT_LOOP_INTERVAL_MS = '1000'
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
          futuresWorkerObserver: (event) =>
            appendFileSync(workerTracePath, `${JSON.stringify(event)}\n`),
          futuresReplayDriverObserver: (event) =>
            appendFileSync(replayDriverTracePath, `${JSON.stringify(event)}\n`),
          futuresSqlObserver: (event) =>
            appendFileSync(sqliteTracePath, `${JSON.stringify(event)}\n`),
          futuresSourceQueueObserver: (event) =>
            appendFileSync(sourceQueueTracePath, `${JSON.stringify(event)}\n`),
          futuresLifecycleObserver: (event) =>
            (() => {
              appendFileSync(closePhasesTracePath, `${JSON.stringify(event)}\n`)
              if (Number.isSafeInteger(event.deferred_source_rows)) {
                closeSourceState = {
                  durable_pending_source_rows: event.deferred_source_rows,
                  source_watermark: Number.isSafeInteger(event.source_watermark)
                    ? event.source_watermark
                    : null,
                  source_count: Number.isSafeInteger(event.source_count)
                    ? event.source_count
                    : null,
                }
              }
            })(),
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
      process.send?.({
        type: 'closed',
        normal_close: true,
        ...closeSourceState,
      })
      process.disconnect()
    }
  } catch (error) {
    process.send?.({
      type: 'error',
      error: error instanceof Error ? error.stack : String(error),
    })
  }
})
