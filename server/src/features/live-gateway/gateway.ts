import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket, { WebSocketServer } from 'ws'
import { LiveMarketFollower } from './market-follower.ts'
import { PaperEngineFollower } from './paper-engine-follower.ts'
import { qwenScoresOff, type QwenScores } from './qwen-scores.ts'
import { CHART_INTERVALS_MS } from './terminal-chart.ts'
import type { SystemUsage } from './system-usage.ts'
import { loadPinnedProducts } from '../kraken-futures/futures-products.ts'

/** Synthetic stream id: the gateway has no engine run, only a market view. */
export const LIVE_RUN_ID = 'live-market-view'
const PRODUCT_ID = 'PF_XBTUSD'
const STREAM_PATH = '/api/terminal/stream'
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_CONNECTIONS = 64
const MAX_BUFFERED_BYTES = 1_048_576
const RING_SIZE = 1_000

type Row = Record<string, unknown>

export interface LiveGatewayOptions {
  readonly marketDbPath: string
  /** D's account DB, read-only. Absent: the engine is reported `off`. */
  readonly accountDbPath?: string
  /** C's verdicts DB, read-only: feeds the analyses panel and chart markers. */
  readonly verdictsDbPath?: string
  /** Reports the engine `unavailable` with this reason (e.g. no Python). */
  readonly engineUnavailableReason?: string
  /** Hits, misses and returns of Qwen's decisions. Absent: reported `off`. */
  readonly qwenScores?: QwenScores
  /** Kronos' forward paper decisions in Qwen's shape. Absent: reported `off`. */
  readonly kronosScores?: QwenScores
  /** JSON written by the dev supervisor with each process's health. */
  readonly processHealthPath?: string
  /** CPU, data size, Qwen and Kronos usage for `/api/system`. Absent: null report. */
  readonly systemUsage?: SystemUsage
  /** Pinned products the Terminal may pick (default: the pinned list). */
  readonly products?: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly staleAfterMs?: number
  readonly pollMs?: number
  readonly heartbeatMs?: number
  readonly clock?: () => number
  /** `mock`: the dev MOCK terminal serves a seeded copy of a market. */
  readonly mode?: 'mock' | 'paper_live'
}

interface Envelope {
  readonly schema_version: 1
  readonly event_id: string
  readonly stream_id: string
  readonly run_id: string
  readonly seq: number
  readonly type: string
  readonly instrument_id: string
  readonly event_time: number
  readonly published_at: number
  readonly data: Row
}

interface Session {
  readonly socket: WebSocket
  subscribed: boolean
  closed: boolean
}

/**
 * Read-only live gateway: HTTP bootstrap plus the terminal WebSocket, fed by
 * tailing the capture process's market database by rowid and, when configured,
 * paper execution D's account DB and C's verdicts DB. It starts no collector
 * and no engine and never writes. Terminal events live in memory only; resume
 * past the ring or across a restart falls back to a snapshot.
 *
 * Each pinned product has its own view (market follower, engine follower,
 * sequence, ring and sessions), created on first use: the Terminal picks it
 * with `?product=` (default PF_XBTUSD) on every request and on the stream.
 */
export async function buildLiveGateway(
  options: LiveGatewayOptions,
): Promise<FastifyInstance> {
  const clock = options.clock ?? Date.now
  const products =
    options.products ?? loadPinnedProducts().map((p) => p.productId)
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      'http://localhost',
      'http://127.0.0.1',
      'http://[::1]',
    ],
  )
  const app = Fastify({ logger: false })

  /** Everything the gateway keeps for one product. */
  interface View {
    readonly productId: string
    readonly instrumentId: string
    readonly follower: LiveMarketFollower
    readonly engine: PaperEngineFollower
    readonly streamId: string
    seq: number
    readonly ring: Envelope[]
    readonly sessions: Set<Session>
  }

  const views = new Map<string, View>()
  const viewOf = (productId: string): View | undefined => {
    const existing = views.get(productId)
    if (existing) return existing
    if (!products.includes(productId)) return undefined
    const follower = new LiveMarketFollower({
      dbPath: options.marketDbPath,
      productId,
      clock,
      staleAfterMs: options.staleAfterMs,
    })
    const view: View = {
      productId,
      instrumentId: `kraken-futures:${productId}`,
      follower,
      engine: new PaperEngineFollower({
        accountDbPath: options.accountDbPath,
        verdictsDbPath: options.verdictsDbPath,
        unavailableReason: options.engineUnavailableReason,
        productId,
        clock,
        markPrice: () => follower.markPrice(),
      }),
      streamId: randomUUID(),
      // Sequence base is the start time in ms: a restarted gateway always
      // issues numbers above anything a previous process could have reached
      // (events are far slower than 1000/s), so stale client cursors resolve
      // to a resync.
      seq: clock(),
      ring: [],
      sessions: new Set(),
    }
    views.set(productId, view)
    return view
  }
  const defaultView = viewOf(PRODUCT_ID) as View
  /** The product a request asks for; `null` when it is not a pinned one. */
  const requested = (value: unknown): View | null =>
    typeof value === 'string' && value.length > 0
      ? (viewOf(value) ?? null)
      : defaultView

  const envelope = (
    view: View,
    type: string,
    data: Row,
    at = clock(),
  ): Envelope => ({
    schema_version: 1,
    event_id: randomUUID(),
    stream_id: view.streamId,
    run_id: LIVE_RUN_ID,
    seq: view.seq,
    type,
    instrument_id: view.instrumentId,
    event_time: at,
    published_at: at,
    data,
  })

  const send = (view: View, session: Session, message: Envelope): void => {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) return
    if (session.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      closeForResync(view, session, 'backpressure')
      return
    }
    session.socket.send(JSON.stringify(message), { compress: false })
  }

  function closeForResync(view: View, session: Session, reason: string): void {
    if (session.closed) return
    send0(
      session,
      envelope(view, 'resync.required', { reason, last_seq: view.seq }),
    )
    session.closed = true
    view.sessions.delete(session)
    session.socket.close(1013, `resync:${reason}`)
  }

  function send0(session: Session, message: Envelope): void {
    if (session.socket.readyState === WebSocket.OPEN)
      session.socket.send(JSON.stringify(message), { compress: false })
  }

  const snapshot = (view: View): Envelope =>
    envelope(view, 'snapshot', {
      watermark: view.seq,
      state: {
        run_id: LIVE_RUN_ID,
        state_version: 0,
        engine: view.engine.engineStatus(),
        market: {
          ...view.follower.marketView(),
          ...view.follower.priceFields(),
        },
        ...view.engine.snapshotFields(),
      },
      market: view.follower.terminalMarket(),
    })

  const publish = (view: View, data: Row, type = 'market.updated'): void => {
    view.seq += 1
    const event = envelope(view, type, data)
    view.ring.push(event)
    if (view.ring.length > RING_SIZE)
      view.ring.splice(0, view.ring.length - RING_SIZE)
    for (const session of [...view.sessions])
      if (session.subscribed) send(view, session, event)
  }

  // The engine view was rebuilt (account DB replaced or first seen after a
  // snapshot was served): every client resyncs from a fresh snapshot.
  const resyncAll = (view: View, reason: string): void => {
    for (const session of [...view.sessions])
      if (session.subscribed) closeForResync(view, session, reason)
    view.ring.length = 0
    view.seq += 1
  }

  const poll = (): void => {
    for (const view of views.values()) {
      try {
        for (const data of view.follower.poll()) publish(view, data)
      } catch (error) {
        console.error('[live-gateway] poll failed', error)
      }
      // After the market poll, so equity is marked to the newest price.
      try {
        for (const event of view.engine.poll())
          if (event.type === 'resync.required')
            resyncAll(view, String(event.data.reason))
          else publish(view, event.data, event.type)
      } catch (error) {
        console.error('[live-gateway] engine poll failed', error)
      }
    }
  }
  const pollTimer = setInterval(poll, options.pollMs ?? 250)
  const heartbeatTimer = setInterval(() => {
    for (const view of views.values())
      for (const session of view.sessions) {
        if (!session.subscribed || session.socket.readyState !== WebSocket.OPEN)
          continue
        send(view, session, envelope(view, 'heartbeat', { at: clock() }))
        session.socket.ping()
      }
  }, options.heartbeatMs ?? 15_000)

  const unknownProduct = { error: { code: 'unknown_product' } }
  app.get<{ Querystring: { product?: string } }>(
    '/api/terminal/bootstrap',
    (request, reply) => {
      const view = requested(request.query.product)
      if (!view) return reply.code(400).send(unknownProduct)
      const market = view.follower.marketView()
      const hash = view.follower.metadataHash()
      return {
        schema_version: 1,
        mode: options.mode ?? 'paper_live',
        source: 'kraken-public-live-stream.v1',
        active_run_id: LIVE_RUN_ID,
        instrument_id: view.instrumentId,
        product_id: view.productId,
        products,
        quote_currency: 'USD',
        ...(hash ? { metadata_hash: hash } : {}),
        terminal_market: view.follower.terminalMarket(),
        market,
        engine: view.engine.engineStatus(),
      }
    },
  )
  app.get<{ Querystring: { interval_ms?: string; product?: string } }>(
    '/api/terminal/chart',
    async (request, reply) => {
      const view = requested(request.query.product)
      if (!view) return reply.code(400).send(unknownProduct)
      const interval = Number(request.query.interval_ms ?? 60_000)
      if (!(CHART_INTERVALS_MS as readonly number[]).includes(interval))
        return reply.code(400).send({ error: { code: 'unsupported_interval' } })
      return view.follower.terminalChart(interval)
    },
  )
  app.get('/api/health', () => ({
    process: 'live-gateway',
    capture: defaultView.follower.status(),
    engine: defaultView.engine.engineStatus(),
    processes: readProcessHealth(options.processHealthPath),
  }))
  app.get('/api/system', () => options.systemUsage?.report() ?? null)
  const qwenScores =
    options.qwenScores ?? qwenScoresOff('decisions_not_configured')
  app.get<{ Querystring: { product?: string } }>(
    '/api/qwen/scores',
    async (request, reply) => {
      const result = await qwenScores.report(request.query.product ?? '')
      if (result.status === 'error' && result.reason === 'invalid_product')
        return reply.code(400).send(result)
      return result
    },
  )
  const kronosScores =
    options.kronosScores ?? qwenScoresOff('kronos_not_configured')
  app.get<{ Querystring: { product?: string } }>(
    '/api/kronos/scores',
    async (request, reply) => {
      const result = await kronosScores.report(request.query.product ?? '')
      if (result.status === 'error' && result.reason === 'invalid_product')
        return reply.code(400).send(result)
      return result
    },
  )
  app.get(STREAM_PATH, async (_request, reply) =>
    reply.code(426).send({ error: { code: 'websocket_required' } }),
  )

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: MAX_MESSAGE_BYTES,
  })
  let closing = false
  const onUpgrade = (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      return reject(socket, 400, 'Bad Request')
    }
    if (url.pathname !== STREAM_PATH) return
    if (closing) return reject(socket, 503, 'Service Unavailable')
    if (wss.clients.size >= MAX_CONNECTIONS)
      return reject(socket, 429, 'Too Many Requests')
    if (!isLoopback(socket.remoteAddress))
      return reject(socket, 403, 'Forbidden')
    const origin = request.headers.origin
    if (typeof origin !== 'string' || !allowedOrigins.has(origin))
      return reject(socket, 403, 'Forbidden')
    const view = requested(url.searchParams.get('product') ?? undefined)
    if (!view) return reject(socket, 404, 'Unknown Product')
    socket.on('error', () => undefined)
    wss.handleUpgrade(request, socket, head, (websocket) =>
      wss.emit('connection', websocket, request, view),
    )
  }
  app.server.on('upgrade', onUpgrade)

  const subscribe = (view: View, session: Session): void => {
    session.subscribed = true
    send(view, session, snapshot(view))
  }
  const control = (
    view: View,
    session: Session,
    type: string,
    data: Row,
  ): void => send0(session, envelope(view, type, data))

  const resume = (view: View, session: Session, lastSeq: number): void => {
    if (lastSeq > view.seq) {
      control(view, session, 'resync.required', {
        reason: 'future_cursor',
        last_seq: lastSeq,
      })
      subscribe(view, session)
      return
    }
    const oldest = view.ring[0]
    if (lastSeq < view.seq && (!oldest || oldest.seq > lastSeq + 1)) {
      control(view, session, 'resync.required', {
        reason: 'cursor_expired',
        last_seq: lastSeq,
      })
      subscribe(view, session)
      return
    }
    session.subscribed = true
    for (const event of view.ring)
      if (event.seq > lastSeq) send(view, session, event)
  }

  wss.on(
    'connection',
    (socket: WebSocket, _request: IncomingMessage, view: View) => {
      const session: Session = { socket, subscribed: false, closed: false }
      view.sessions.add(session)
      socket.on('message', (raw) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(
            (Array.isArray(raw)
              ? Buffer.concat(raw)
              : Buffer.from(raw as Buffer)
            ).toString('utf8'),
          )
        } catch {
          control(view, session, 'protocol.error', { code: 'invalid_message' })
          return
        }
        const message = parsed as Row
        if (
          typeof message !== 'object' ||
          message === null ||
          message.schema_version !== 1 ||
          typeof message.type !== 'string'
        ) {
          control(view, session, 'protocol.error', { code: 'invalid_message' })
          return
        }
        if (message.run_id !== LIVE_RUN_ID) {
          control(view, session, 'protocol.error', { code: 'run_not_found' })
          return
        }
        if (message.type === 'subscribe') subscribe(view, session)
        else if (
          message.type === 'resume' &&
          Number.isSafeInteger(message.last_seq) &&
          (message.last_seq as number) >= 0
        )
          resume(view, session, message.last_seq as number)
        else if (message.type === 'history.request')
          control(view, session, 'history.page', {
            events: [],
            before_seq: message.before_seq ?? Number.MAX_SAFE_INTEGER,
            next_before_seq: null,
          })
        else if (message.type === 'paper.command')
          control(view, session, 'protocol.error', {
            code: view.engine.enabled ? 'commands_unavailable' : 'engine_off',
          })
        else if (message.type === 'analysis.detail.request')
          control(view, session, 'protocol.error', {
            code: 'analysis_not_found',
          })
        else
          control(view, session, 'protocol.error', { code: 'invalid_message' })
      })
      const drop = (): void => {
        session.closed = true
        view.sessions.delete(session)
      }
      socket.on('error', drop)
      socket.on('close', drop)
    },
  )

  app.addHook('onClose', async () => {
    closing = true
    clearInterval(pollTimer)
    clearInterval(heartbeatTimer)
    app.server.removeListener('upgrade', onUpgrade)
    for (const view of views.values()) {
      for (const session of view.sessions) {
        session.closed = true
        session.socket.terminate()
      }
      view.sessions.clear()
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    for (const view of views.values()) {
      view.follower.close()
      view.engine.close()
    }
  })
  return app
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (normalized === '::1' || normalized === 'localhost') return true
  return isIP(normalized) === 4 && normalized.startsWith('127.')
}

/** The supervisor's health file, or null when absent or unreadable. */
function readProcessHealth(path: string | undefined): unknown {
  if (!path) return null
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as Row).processes ?? null
  } catch {
    return null
  }
}

function reject(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}
