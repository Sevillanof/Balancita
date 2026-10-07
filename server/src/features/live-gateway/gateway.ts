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

/** Synthetic stream id: the gateway has no engine run, only a market view. */
export const LIVE_RUN_ID = 'live-market-view'
const INSTRUMENT_ID = 'kraken-futures:PF_XBTUSD'
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
  readonly allowedOrigins?: readonly string[]
  readonly staleAfterMs?: number
  readonly pollMs?: number
  readonly heartbeatMs?: number
  readonly clock?: () => number
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
 */
export async function buildLiveGateway(
  options: LiveGatewayOptions,
): Promise<FastifyInstance> {
  const clock = options.clock ?? Date.now
  const follower = new LiveMarketFollower({
    dbPath: options.marketDbPath,
    clock,
    staleAfterMs: options.staleAfterMs,
  })
  const engine = new PaperEngineFollower({
    accountDbPath: options.accountDbPath,
    verdictsDbPath: options.verdictsDbPath,
    unavailableReason: options.engineUnavailableReason,
    clock,
    markPrice: () => follower.markPrice(),
  })
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      'http://localhost',
      'http://127.0.0.1',
      'http://[::1]',
    ],
  )
  const app = Fastify({ logger: false })
  const streamId = randomUUID()
  // Sequence base is the start time in ms: a restarted gateway always issues
  // numbers above anything a previous process could have reached (events are
  // far slower than 1000/s), so stale client cursors resolve to a resync.
  let seq = clock()
  const ring: Envelope[] = []
  const sessions = new Set<Session>()

  const envelope = (type: string, data: Row, at = clock()): Envelope => ({
    schema_version: 1,
    event_id: randomUUID(),
    stream_id: streamId,
    run_id: LIVE_RUN_ID,
    seq,
    type,
    instrument_id: INSTRUMENT_ID,
    event_time: at,
    published_at: at,
    data,
  })

  const send = (session: Session, message: Envelope): void => {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) return
    if (session.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      closeForResync(session, 'backpressure')
      return
    }
    session.socket.send(JSON.stringify(message), { compress: false })
  }

  function closeForResync(session: Session, reason: string): void {
    if (session.closed) return
    send0(session, envelope('resync.required', { reason, last_seq: seq }))
    session.closed = true
    sessions.delete(session)
    session.socket.close(1013, `resync:${reason}`)
  }

  function send0(session: Session, message: Envelope): void {
    if (session.socket.readyState === WebSocket.OPEN)
      session.socket.send(JSON.stringify(message), { compress: false })
  }

  const snapshot = (): Envelope =>
    envelope('snapshot', {
      watermark: seq,
      state: {
        run_id: LIVE_RUN_ID,
        state_version: 0,
        engine: engine.engineStatus(),
        market: { ...follower.marketView(), ...follower.priceFields() },
        ...engine.snapshotFields(),
      },
      market: follower.terminalMarket(),
    })

  const publish = (data: Row, type = 'market.updated'): void => {
    seq += 1
    const event = envelope(type, data)
    ring.push(event)
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)
    for (const session of [...sessions])
      if (session.subscribed) send(session, event)
  }

  // The engine view was rebuilt (account DB replaced or first seen after a
  // snapshot was served): every client resyncs from a fresh snapshot.
  const resyncAll = (reason: string): void => {
    for (const session of [...sessions])
      if (session.subscribed) closeForResync(session, reason)
    ring.length = 0
    seq += 1
  }

  const poll = (): void => {
    try {
      for (const data of follower.poll()) publish(data)
    } catch (error) {
      console.error('[live-gateway] poll failed', error)
    }
    // After the market poll, so equity is marked to the newest price.
    try {
      for (const event of engine.poll())
        if (event.type === 'resync.required')
          resyncAll(String(event.data.reason))
        else publish(event.data, event.type)
    } catch (error) {
      console.error('[live-gateway] engine poll failed', error)
    }
  }
  const pollTimer = setInterval(poll, options.pollMs ?? 250)
  const heartbeatTimer = setInterval(() => {
    for (const session of sessions) {
      if (!session.subscribed || session.socket.readyState !== WebSocket.OPEN)
        continue
      send(session, envelope('heartbeat', { at: clock() }))
      session.socket.ping()
    }
  }, options.heartbeatMs ?? 15_000)

  app.get('/api/terminal/bootstrap', () => {
    const market = follower.marketView()
    const hash = follower.metadataHash()
    return {
      schema_version: 1,
      mode: 'paper_live',
      source: 'kraken-public-live-stream.v1',
      active_run_id: LIVE_RUN_ID,
      instrument_id: INSTRUMENT_ID,
      product_id: PRODUCT_ID,
      quote_currency: 'USD',
      ...(hash ? { metadata_hash: hash } : {}),
      terminal_market: follower.terminalMarket(),
      market,
      engine: engine.engineStatus(),
    }
  })
  app.get<{ Querystring: { interval_ms?: string } }>(
    '/api/terminal/chart',
    async (request, reply) => {
      const interval = Number(request.query.interval_ms ?? 60_000)
      if (!(CHART_INTERVALS_MS as readonly number[]).includes(interval))
        return reply.code(400).send({ error: { code: 'unsupported_interval' } })
      return follower.terminalChart(interval)
    },
  )
  app.get('/api/health', () => ({
    process: 'live-gateway',
    capture: follower.status(),
    engine: engine.engineStatus(),
  }))
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
    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      return reject(socket, 400, 'Bad Request')
    }
    if (pathname !== STREAM_PATH) return
    if (closing) return reject(socket, 503, 'Service Unavailable')
    if (wss.clients.size >= MAX_CONNECTIONS)
      return reject(socket, 429, 'Too Many Requests')
    if (!isLoopback(socket.remoteAddress))
      return reject(socket, 403, 'Forbidden')
    const origin = request.headers.origin
    if (typeof origin !== 'string' || !allowedOrigins.has(origin))
      return reject(socket, 403, 'Forbidden')
    socket.on('error', () => undefined)
    wss.handleUpgrade(request, socket, head, (websocket) =>
      wss.emit('connection', websocket, request),
    )
  }
  app.server.on('upgrade', onUpgrade)

  const subscribe = (session: Session): void => {
    session.subscribed = true
    send(session, snapshot())
  }
  const control = (session: Session, type: string, data: Row): void =>
    send0(session, envelope(type, data))

  const resume = (session: Session, lastSeq: number): void => {
    if (lastSeq > seq) {
      control(session, 'resync.required', {
        reason: 'future_cursor',
        last_seq: lastSeq,
      })
      subscribe(session)
      return
    }
    const oldest = ring[0]
    if (lastSeq < seq && (!oldest || oldest.seq > lastSeq + 1)) {
      control(session, 'resync.required', {
        reason: 'cursor_expired',
        last_seq: lastSeq,
      })
      subscribe(session)
      return
    }
    session.subscribed = true
    for (const event of ring) if (event.seq > lastSeq) send(session, event)
  }

  wss.on('connection', (socket) => {
    const session: Session = { socket, subscribed: false, closed: false }
    sessions.add(session)
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
        control(session, 'protocol.error', { code: 'invalid_message' })
        return
      }
      const message = parsed as Row
      if (
        typeof message !== 'object' ||
        message === null ||
        message.schema_version !== 1 ||
        typeof message.type !== 'string'
      ) {
        control(session, 'protocol.error', { code: 'invalid_message' })
        return
      }
      if (message.run_id !== LIVE_RUN_ID) {
        control(session, 'protocol.error', { code: 'run_not_found' })
        return
      }
      if (message.type === 'subscribe') subscribe(session)
      else if (
        message.type === 'resume' &&
        Number.isSafeInteger(message.last_seq) &&
        (message.last_seq as number) >= 0
      )
        resume(session, message.last_seq as number)
      else if (message.type === 'history.request')
        control(session, 'history.page', {
          events: [],
          before_seq: message.before_seq ?? Number.MAX_SAFE_INTEGER,
          next_before_seq: null,
        })
      else if (message.type === 'paper.command')
        control(session, 'protocol.error', {
          code: engine.enabled ? 'commands_unavailable' : 'engine_off',
        })
      else if (message.type === 'analysis.detail.request')
        control(session, 'protocol.error', { code: 'analysis_not_found' })
      else control(session, 'protocol.error', { code: 'invalid_message' })
    })
    const drop = (): void => {
      session.closed = true
      sessions.delete(session)
    }
    socket.on('error', drop)
    socket.on('close', drop)
  })

  app.addHook('onClose', async () => {
    closing = true
    clearInterval(pollTimer)
    clearInterval(heartbeatTimer)
    app.server.removeListener('upgrade', onUpgrade)
    for (const session of sessions) {
      session.closed = true
      session.socket.terminate()
    }
    sessions.clear()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    follower.close()
    engine.close()
  })
  return app
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (normalized === '::1' || normalized === 'localhost') return true
  return isIP(normalized) === 4 && normalized.startsWith('127.')
}

function reject(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}
