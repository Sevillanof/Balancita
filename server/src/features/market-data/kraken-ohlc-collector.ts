import type { FastReplayCandle } from '../simulations/fast-replay-engine.ts'
import type { MarketStore } from './market-store.ts'

export interface KrakenOhlcCollectorLogger {
  warn(fields: Record<string, unknown>, message: string): void
}

export interface KrakenOhlcCollectorTimer {
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
}

export interface KrakenOhlcCollectorStatus {
  readonly running: boolean
  readonly lastSuccessfulSync: number
  readonly candleCount: number
  readonly minTimestamp: string | null
  readonly maxTimestamp: string | null
  readonly coverageHours: number
  readonly gapCount: number
}

export interface NewlyClosedOhlcCandle {
  readonly candle: FastReplayCandle
  readonly nextOpen?: number
}

const defaultTimer: KrakenOhlcCollectorTimer = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
}

export class KrakenOhlcCollector {
  private readonly store: MarketStore
  private readonly baseUrl: string
  private readonly fetcher: (url: string) => Promise<Response>
  private readonly clock: () => number
  private readonly intervalMs: number
  private readonly timer: KrakenOhlcCollectorTimer
  private readonly logger: KrakenOhlcCollectorLogger
  private readonly onClosedCandles:
    ((candles: readonly NewlyClosedOhlcCandle[]) => void) | undefined
  private primed = false
  private pendingLiveCandles: NewlyClosedOhlcCandle[] = []
  private timerHandle: unknown
  private running = false
  private inFlight: Promise<void> | undefined

  constructor(input: {
    readonly store: MarketStore
    readonly baseUrl: string
    readonly fetch?: (url: string) => Promise<Response>
    readonly clock?: () => number
    readonly intervalMs?: number
    readonly timer?: KrakenOhlcCollectorTimer
    readonly logger: KrakenOhlcCollectorLogger
    readonly onClosedCandles?: (
      candles: readonly NewlyClosedOhlcCandle[],
    ) => void
  }) {
    this.store = input.store
    this.baseUrl = input.baseUrl
    this.fetcher = input.fetch ?? ((url) => fetch(url))
    this.clock = input.clock ?? (() => Date.now())
    this.intervalMs = input.intervalMs ?? 600_000
    this.timer = input.timer ?? defaultTimer
    this.logger = input.logger
    this.onClosedCandles = input.onClosedCandles
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.runSync()
    this.timerHandle = this.timer.setInterval(() => {
      if (this.inFlight === undefined) void this.runSync()
    }, this.intervalMs)
  }

  async stop(): Promise<void> {
    if (this.timerHandle !== undefined) {
      this.timer.clearInterval(this.timerHandle)
      this.timerHandle = undefined
    }
    this.running = false
    await this.inFlight
  }

  async syncOnce(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    return this.runSync()
  }

  getStatus(): KrakenOhlcCollectorStatus {
    const metrics = this.store.ohlcHistoryMetrics()
    const format = (timestamp: number | null) =>
      timestamp === null ? null : new Date(timestamp * 1000).toISOString()
    return {
      running: this.running,
      lastSuccessfulSync: this.store.getOhlcCollectorState().lastSuccessfulSync,
      candleCount: metrics.candleCount,
      minTimestamp: format(metrics.minTimestamp),
      maxTimestamp: format(metrics.maxTimestamp),
      coverageHours: metrics.coverageHours,
      gapCount: metrics.gapCount,
    }
  }

  private runSync(): Promise<void> {
    const task = this.sync()
      .catch((error: unknown) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Kraken OHLC synchronization failed.',
        )
      })
      .finally(() => {
        this.inFlight = undefined
      })
    this.inFlight = task
    return task
  }

  private async sync(): Promise<void> {
    const state = this.store.getOhlcCollectorState()
    const cursor = state.cursor ?? this.store.latestOhlcTimestamp()
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/public/OHLC`)
    url.searchParams.set('pair', 'XBTEUR')
    url.searchParams.set('interval', '1')
    if (cursor !== null) url.searchParams.set('since', String(cursor))
    const response = await this.fetcher(url.toString())
    if (!response.ok)
      throw new Error(`Kraken OHLC returned HTTP ${response.status}.`)
    const body = (await response.json()) as {
      error?: unknown
      result?: Record<string, unknown>
    }
    if (!Array.isArray(body.error) || body.error.length > 0)
      throw new Error('Kraken OHLC response contains an upstream error.')
    const result = body.result
    const rows =
      result?.XBTEUR ??
      Object.entries(result ?? {}).find(
        ([key, value]) => key !== 'last' && Array.isArray(value),
      )?.[1]
    if (
      !Array.isArray(rows) ||
      typeof result?.last !== 'number' ||
      !Number.isSafeInteger(result.last)
    )
      throw new Error('Kraken OHLC response is malformed.')

    const nowSeconds = Math.floor(this.clock() / 1000)
    const candles: FastReplayCandle[] = rows.flatMap((raw, index) => {
      if (!Array.isArray(raw) || raw.length < 7)
        throw new Error('Kraken OHLC candle is malformed.')
      const [timestamp, open, high, low, close, , volume] = raw.map(Number)
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        ![open, high, low, close, volume].every(Number.isFinite) ||
        open <= 0 ||
        high < Math.max(open, close) ||
        low <= 0 ||
        low > Math.min(open, close) ||
        close <= 0 ||
        volume < 0
      )
        throw new Error('Kraken OHLC candle contains invalid numeric values.')
      if (index === rows.length - 1 || timestamp + 60 > nowSeconds) return []
      return [{ timestamp, open, high, low, close, volume }]
    })

    const existingTimestamps = new Set(
      this.store
        .listOhlcCandles(0, Number.MAX_SAFE_INTEGER)
        .map(({ timestamp }) => timestamp),
    )
    this.store.insertOhlcCandles(candles)
    const newlyClosed = candles
      .filter(({ timestamp }) => !existingTimestamps.has(timestamp))
      .sort((left, right) => left.timestamp - right.timestamp)
    if (this.primed) {
      const unfinished = rows.at(-1)
      const unfinishedTimestamp = Array.isArray(unfinished)
        ? Number(unfinished[0])
        : undefined
      this.pendingLiveCandles.push(
        ...newlyClosed.map((candle) => {
          const following = candles.find(
            (candidate) => candidate.timestamp === candle.timestamp + 60,
          )
          const nextOpen =
            following?.open ??
            (unfinishedTimestamp === candle.timestamp + 60 &&
            Array.isArray(unfinished)
              ? Number(unfinished[1])
              : undefined)
          return nextOpen === undefined ? { candle } : { candle, nextOpen }
        }),
      )
    }
    const allCandles = this.store.listOhlcCandles(0, Number.MAX_SAFE_INTEGER)
    for (let index = 1; index < allCandles.length; index += 1) {
      const previous = allCandles[index - 1]!.timestamp
      const current = allCandles[index]!.timestamp
      if (current - previous > 60 && !existingTimestamps.has(current))
        this.logger.warn(
          { start: previous + 60, end: current - 60 },
          'Gap detected in stored Kraken OHLC candles.',
        )
    }
    this.store.saveOhlcCollectorState(result.last, this.clock())
    this.primed = true
    if (
      this.pendingLiveCandles.length > 0 &&
      this.onClosedCandles !== undefined
    ) {
      const pending = this.pendingLiveCandles
      this.onClosedCandles(pending)
      this.pendingLiveCandles = []
    }
  }
}
