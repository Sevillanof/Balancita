import type { FastReplayCandle } from '../simulations/fast-replay-engine.ts'
import type { PaperForwardService } from '../simulations/paper-forward.ts'

export interface PaperOhlcSocket {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: ((event?: { type?: string }) => void) | null
  onclose: ((event?: { code?: number; reason?: string }) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>
type Timer = ReturnType<typeof setTimeout>

export function nextKrakenPaperPollDelay(now: number): number {
  const minute = 60_000
  const next = Math.floor(now / minute) * minute + 5_000
  return next <= now ? next + minute - now : next - now
}

export class KrakenPaperOhlcCollector {
  private readonly options: {
    service: PaperForwardService
    url: string
    webSocketFactory?: (url: string) => PaperOhlcSocket
    restBaseUrl?: string
    marketFetch?: Fetch
    clock?: () => number
    setTimeout?: typeof setTimeout
    clearTimeout?: typeof clearTimeout
    logger?: { error(fields: Record<string, unknown>, message: string): void }
    reconnectMinMs?: number
    reconnectMaxMs?: number
  }
  private socket?: PaperOhlcSocket
  private reconnectTimer?: Timer
  private pollTimer?: Timer
  private current?: FastReplayCandle
  private stopped = true
  private attempt = 0
  private state = 'stopped'
  private polling = false
  private lastConsumed = -1
  private readonly clock: () => number
  private readonly makeSocket: (url: string) => PaperOhlcSocket
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(options: {
    service: PaperForwardService
    url: string
    webSocketFactory?: (url: string) => PaperOhlcSocket
    restBaseUrl?: string
    marketFetch?: Fetch
    clock?: () => number
    setTimeout?: typeof setTimeout
    clearTimeout?: typeof clearTimeout
    logger?: { error(fields: Record<string, unknown>, message: string): void }
    reconnectMinMs?: number
    reconnectMaxMs?: number
  }) {
    this.options = options
    this.clock = options.clock ?? Date.now
    this.setTimer = options.setTimeout ?? setTimeout
    this.clearTimer = options.clearTimeout ?? clearTimeout
    this.lastConsumed =
      options.service.lastProcessedCandleTimestamp() ??
      options.service.storeLatestOhlcTimestamp() ??
      -1
    this.makeSocket =
      options.webSocketFactory ??
      ((url) => {
        const native = new WebSocket(url)
        const socket: PaperOhlcSocket = {
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send: (data) => native.send(data),
          close: (code, reason) => native.close(code, reason),
        }
        native.addEventListener('open', () => socket.onopen?.())
        native.addEventListener('message', (event) =>
          socket.onmessage?.({ data: String(event.data) }),
        )
        native.addEventListener('error', (event) =>
          socket.onerror?.({ type: event.type }),
        )
        native.addEventListener('close', (event) =>
          socket.onclose?.({ code: event.code, reason: event.reason }),
        )
        return socket
      })
  }

  start(): void {
    if (this.stopped) {
      this.stopped = false
      this.connect()
    }
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const socket = this.socket
    this.socket = undefined
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      socket.close()
    }
    this.state = 'stopped'
    this.options.service.setRunning(false)
    this.options.service.setStreamState(this.state)
  }

  getStatus(): { running: boolean; state: string } {
    return {
      running:
        !this.stopped &&
        (this.state === 'connected' || this.state === 'rest_polling_1m'),
      state: this.state,
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.state = this.attempt ? 'reconnecting' : 'connecting'
    this.options.service.setStreamState(this.state)
    const socket = this.makeSocket(this.options.url)
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return
      this.clearPollTimer()
      this.polling = false
      this.state = 'connected'
      this.attempt = 0
      this.options.service.setRunning(true)
      this.options.service.setStreamState(this.state)
      try {
        socket.send(
          JSON.stringify({
            method: 'subscribe',
            params: {
              channel: 'ohlc',
              symbol: ['BTC/EUR'],
              interval: 1,
              snapshot: true,
            },
          }),
        )
      } catch (error) {
        this.fail('send', {
          code: 'send_failed',
          reason: safeReason(error instanceof Error ? error.message : ''),
        })
      }
    }
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data)
    }
    socket.onerror = (event) => {
      if (this.socket === socket)
        this.fail('error', { code: event?.type ?? 'error' })
    }
    socket.onclose = (event) => {
      if (this.socket === socket)
        this.fail('close', {
          code: event?.code,
          reason: safeReason(event?.reason),
        })
    }
  }

  private receive(raw: string): void {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      this.fail('message', { code: 'invalid_json' })
      return
    }
    if (!data || typeof data !== 'object') return
    const message = data as {
      channel?: unknown
      type?: unknown
      data?: unknown
      method?: unknown
      success?: unknown
      error?: unknown
    }
    if (message.method === 'subscribe' && message.success === false) {
      this.fail('subscribe', {
        code: 'subscription_rejected',
        reason: safeReason(message.error),
      })
      return
    }
    if (message.channel !== 'ohlc' || !Array.isArray(message.data)) return
    for (const item of message.data) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (row.symbol !== 'BTC/EUR') continue
      const start = Date.parse(String(row.interval_begin))
      const candle = {
        timestamp: Math.floor(start / 1000),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      }
      if (!Number.isFinite(start) || !valid(candle)) continue
      this.options.service.recordReceivedEvent(start, this.clock())
      if (message.type === 'snapshot' || this.current === undefined) {
        this.current = candle
        continue
      }
      if (candle.timestamp <= this.current.timestamp) {
        if (candle.timestamp === this.current.timestamp) this.current = candle
        continue
      }
      const prior = this.current
      this.current = candle
      if (prior.timestamp > this.lastConsumed) {
        this.consume(
          prior,
          candle.timestamp - prior.timestamp === 60 ? candle.open : undefined,
        )
      }
    }
  }

  private consume(candle: FastReplayCandle, nextOpen?: number): void {
    if (candle.timestamp <= this.lastConsumed) return
    this.options.service.processClosedCandle(candle, nextOpen)
    this.lastConsumed = candle.timestamp
  }

  private fail(event: string, metadata: Record<string, unknown>): void {
    if (this.stopped) return
    this.options.logger?.error(
      { event, ...metadata },
      'Kraken paper OHLC WebSocket failed; reconnecting.',
    )
    const socket = this.socket
    if (socket) {
      this.socket = undefined
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      socket.close()
    }
    const min = this.options.reconnectMinMs ?? 1_000
    const max = this.options.reconnectMaxMs ?? 30_000
    const delay = Math.min(max, min * 2 ** this.attempt++)
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
    if (this.options.restBaseUrl && this.options.marketFetch) {
      this.state = 'rest_polling_1m'
      this.options.service.setRunning(true)
      this.options.service.setStreamState(this.state)
      this.schedulePoll()
    } else {
      this.state = 'failed'
      this.options.service.setRunning(false)
      this.options.service.setStreamState(this.state)
    }
  }

  private schedulePoll(): void {
    if (
      this.stopped ||
      this.state !== 'rest_polling_1m' ||
      this.pollTimer !== undefined ||
      !this.options.marketFetch
    )
      return
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = undefined
      void this.pollRest()
    }, nextKrakenPaperPollDelay(this.clock()))
  }

  private async pollRest(): Promise<void> {
    if (
      this.stopped ||
      this.state !== 'rest_polling_1m' ||
      this.polling ||
      !this.options.marketFetch ||
      !this.options.restBaseUrl
    )
      return
    this.polling = true
    try {
      const latest =
        this.options.service.lastProcessedCandleTimestamp() ??
        this.options.service.storeLatestOhlcTimestamp()
      const url = `${this.options.restBaseUrl.replace(/\/+$/, '')}/public/OHLC?pair=XBTEUR&interval=1${latest === null ? '' : `&since=${latest}`}`
      const response = await this.options.marketFetch(url, {
        headers: { Accept: 'application/json' },
      })
      if (!response.ok)
        throw Object.assign(new Error('HTTP request failed'), {
          status: response.status,
        })
      const payload: unknown = await response.json()
      const rows = parseOhlcResponse(payload)
      const candles = rows
        .map(toCandle)
        .filter((row): row is FastReplayCandle => row !== null)
      for (let index = 0; index < candles.length - 1; index += 1) {
        const candle = candles[index]!
        if (candle.timestamp <= this.lastConsumed) continue
        const next = candles[index + 1]
        this.options.service.recordReceivedEvent(
          candle.timestamp * 1000,
          this.clock(),
        )
        this.consume(
          candle,
          next?.timestamp === candle.timestamp + 60 ? next.open : undefined,
        )
      }
    } catch (error) {
      this.options.logger?.error(
        {
          event: 'rest_poll',
          code: 'request_failed',
          status: safeStatus(error),
          reason: safeReason(error instanceof Error ? error.message : ''),
        },
        'Kraken paper OHLC REST fallback failed.',
      )
    } finally {
      this.polling = false
      if (this.state === 'rest_polling_1m') this.schedulePoll()
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) this.clearTimer(this.pollTimer)
    this.pollTimer = undefined
  }
  private clearTimers(): void {
    if (this.reconnectTimer !== undefined) this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.clearPollTimer()
  }
}

function parseOhlcResponse(value: unknown): unknown[] {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid Kraken OHLC response')
  const response = value as { error?: unknown; result?: unknown }
  if (!Array.isArray(response.error) || response.error.length > 0)
    throw new Error('Kraken OHLC API returned an error')
  if (!response.result || typeof response.result !== 'object')
    throw new Error('Kraken OHLC response has no result')
  const pairs = Object.entries(
    response.result as Record<string, unknown>,
  ).filter(([key]) => key !== 'last')
  const pair = pairs.find(([key]) => /^(?:XXBTZEUR|XBTZEUR|XBTEUR)$/.test(key))
  if (!pair || !Array.isArray(pair[1]))
    throw new Error('Kraken OHLC response has no BTC-EUR pair')
  return pair[1]
}

function toCandle(row: unknown): FastReplayCandle | null {
  if (!Array.isArray(row) || row.length < 7) return null
  const candle = {
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[6]),
  }
  return Number.isSafeInteger(candle.timestamp) && valid(candle) ? candle : null
}

function safeStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error))
    return undefined
  const status = (error as { status: unknown }).status
  return typeof status === 'number' ? status : undefined
}
function safeReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined
  return reason.replace(/[\r\n\t]/g, ' ').slice(0, 160)
}
function valid(candle: FastReplayCandle): boolean {
  return (
    [
      candle.timestamp,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
    ].every(Number.isFinite) &&
    candle.timestamp >= 0 &&
    candle.open > 0 &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.low > 0 &&
    candle.volume >= 0
  )
}
