import type {
  Candle,
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../domain/market-data'
import {
  KRAKEN_PAIR,
  domainToKrakenRestPair,
  domainToKrakenWebSocketSymbol,
  krakenWebSocketSymbolToDomain,
} from './kraken-pairs'

const REST_BASE_URL = 'https://api.kraken.com/0'
const WS_URL = 'wss://ws.kraken.com/v2'
const OHLC_INTERVAL_MINUTES = 1440
const DEFAULT_STALE_AFTER_MS = 15_000
const DEFAULT_RECONNECT_BASE_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 30_000

export type KrakenFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface KrakenWebSocket {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type KrakenWebSocketFactory = (url: string) => KrakenWebSocket

type TimerHandle = ReturnType<typeof globalThis.setTimeout>
type TimerFunction = (handler: () => void, timeout: number) => TimerHandle
type ClearTimerFunction = (handle: TimerHandle) => void

export type KrakenMarketDataProviderOptions = {
  fetch?: KrakenFetch
  webSocketFactory?: KrakenWebSocketFactory
  restBaseUrl?: string
  webSocketUrl?: string
  now?: () => number
  staleAfterMs?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  setTimeout?: TimerFunction
  clearTimeout?: ClearTimerFunction
}

type SubscriptionState = {
  active: boolean
  socket: KrakenWebSocket | null
  lastTickerAt: Map<InstrumentId, number>
  lastQuote: Quote | null
  lastQuoteAt: number | null
  staleTimer: TimerHandle | null
  reconnectTimer: TimerHandle | null
  reconnectAttempt: number
}

type RecordValue = Record<string, unknown>

export class KrakenMarketDataProvider implements MarketDataProvider {
  private readonly fetcher: KrakenFetch
  private readonly webSocketFactory: KrakenWebSocketFactory
  private readonly restBaseUrl: string
  private readonly webSocketUrl: string
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly setTimer: TimerFunction
  private readonly clearTimer: ClearTimerFunction

  constructor(options: KrakenMarketDataProviderOptions = {}) {
    this.fetcher =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory
    this.restBaseUrl = options.restBaseUrl ?? REST_BASE_URL
    this.webSocketUrl = options.webSocketUrl ?? WS_URL
    this.now = options.now ?? (() => Date.now())
    this.staleAfterMs = positiveOrDefault(
      options.staleAfterMs,
      DEFAULT_STALE_AFTER_MS,
    )
    this.reconnectBaseMs = positiveOrDefault(
      options.reconnectBaseMs,
      DEFAULT_RECONNECT_BASE_MS,
    )
    this.reconnectMaxMs = Math.max(
      this.reconnectBaseMs,
      positiveOrDefault(options.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS),
    )
    this.setTimer = options.setTimeout ?? globalThis.setTimeout
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout
  }

  async getInstruments(): Promise<Instrument[]> {
    const path = `/public/AssetPairs?pair=${KRAKEN_PAIR.restPair}`
    const body = await this.requestJson(path)
    return [mapAssetPair(body)]
  }

  async getHistory(instrumentId: InstrumentId): Promise<Candle[]> {
    const restPair = domainToKrakenRestPair(instrumentId)
    const path = `/public/OHLC?pair=${restPair}&interval=${OHLC_INTERVAL_MINUTES}`
    const body = await this.requestJson(path)
    const result = unwrapKrakenResult(body, 'OHLC')
    return mapOhlcCandles(result, restPair)
  }

  subscribe(
    instrumentIds: InstrumentId[],
    onQuote: (quote: Quote) => void,
  ): () => void {
    const uniqueInstrumentIds = [...new Set(instrumentIds)]
    for (const instrumentId of uniqueInstrumentIds) {
      domainToKrakenWebSocketSymbol(instrumentId)
    }
    if (uniqueInstrumentIds.length === 0) return () => undefined

    const state: SubscriptionState = {
      active: true,
      socket: null,
      lastTickerAt: new Map(),
      lastQuote: null,
      lastQuoteAt: null,
      staleTimer: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
    }

    const connect = () => this.connect(state, onQuote)
    connect()

    return () => {
      if (!state.active) return
      state.active = false
      this.clearReconnectTimer(state)
      this.clearStaleTimer(state)
      if (state.socket !== null) {
        this.disposeSocket(state.socket)
        state.socket = null
      }
    }
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await this.fetcher(`${this.restBaseUrl}${path}`, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(`Kraken HTTP ${response.status} for ${path}`)
    }
    try {
      return await response.json()
    } catch (error) {
      throw new Error(`Invalid Kraken JSON response for ${path}`, {
        cause: error,
      })
    }
  }

  private connect(
    state: SubscriptionState,
    onQuote: (quote: Quote) => void,
  ): void {
    if (!state.active) return

    let socket: KrakenWebSocket
    try {
      socket = this.webSocketFactory(this.webSocketUrl)
    } catch {
      this.scheduleReconnect(state, onQuote)
      return
    }
    state.socket = socket

    socket.onopen = () => {
      if (!state.active || state.socket !== socket) return
      state.reconnectAttempt = 0
      socket.send(
        JSON.stringify({
          method: 'subscribe',
          params: {
            channel: 'ticker',
            symbol: [KRAKEN_PAIR.webSocketSymbol],
          },
        }),
      )
    }
    socket.onmessage = (event) => {
      if (!state.active || state.socket !== socket) return
      this.handleMessage(state, socket, event.data, onQuote)
    }
    socket.onerror = () => {
      this.handleSocketFailure(state, socket, onQuote)
    }
    socket.onclose = () => {
      this.handleSocketFailure(state, socket, onQuote)
    }
  }

  private handleMessage(
    state: SubscriptionState,
    socket: KrakenWebSocket,
    rawMessage: string,
    onQuote: (quote: Quote) => void,
  ): void {
    let payload: unknown
    try {
      payload = JSON.parse(rawMessage) as unknown
    } catch {
      this.handleSocketFailure(state, socket, onQuote)
      return
    }

    if (!isRecord(payload) || payload.channel !== 'ticker') return
    if (payload.type !== 'snapshot' && payload.type !== 'update') return
    if (!Array.isArray(payload.data)) {
      this.handleSocketFailure(state, socket, onQuote)
      return
    }

    const quotes: Quote[] = []
    for (const item of payload.data) {
      if (!isRecord(item)) {
        this.handleSocketFailure(state, socket, onQuote)
        return
      }
      if (item.symbol !== KRAKEN_PAIR.webSocketSymbol) continue
      const instrumentId = krakenWebSocketSymbolToDomain(item.symbol)
      const quote = mapTicker(instrumentId, item)
      if (quote === null) {
        this.handleSocketFailure(state, socket, onQuote)
        return
      }
      const timestampMs = Date.parse(quote.timestamp)
      const lastAt = state.lastTickerAt.get(instrumentId)
      if (lastAt !== undefined && timestampMs <= lastAt) {
        // Duplicate and delayed ticker messages are harmless; do not publish
        // them or treat an out-of-order ticker as a socket failure.
        continue
      }
      state.lastTickerAt.set(instrumentId, timestampMs)
      quotes.push(quote)
    }

    for (const quote of quotes) {
      state.lastQuote = quote
      state.lastQuoteAt = this.now()
      onQuote(quote)
      this.scheduleStale(state, onQuote)
    }
  }

  private handleSocketFailure(
    state: SubscriptionState,
    socket: KrakenWebSocket,
    onQuote: (quote: Quote) => void,
  ): void {
    if (!state.active || state.socket !== socket) return
    state.socket = null
    state.lastTickerAt.clear()
    this.clearStaleTimer(state)
    this.markStale(state, onQuote)
    this.disposeSocket(socket)
    this.scheduleReconnect(state, onQuote)
  }

  private scheduleReconnect(
    state: SubscriptionState,
    onQuote: (quote: Quote) => void,
  ): void {
    if (!state.active || state.reconnectTimer !== null) return
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** state.reconnectAttempt,
    )
    state.reconnectAttempt += 1
    state.reconnectTimer = this.setTimer(() => {
      state.reconnectTimer = null
      this.connect(state, onQuote)
    }, delay)
  }

  private scheduleStale(
    state: SubscriptionState,
    onQuote: (quote: Quote) => void,
  ): void {
    this.clearStaleTimer(state)
    state.staleTimer = this.setTimer(() => {
      state.staleTimer = null
      if (
        state.active &&
        state.lastQuoteAt !== null &&
        this.now() - state.lastQuoteAt >= this.staleAfterMs
      ) {
        this.markStale(state, onQuote)
      }
    }, this.staleAfterMs)
  }

  private markStale(
    state: SubscriptionState,
    onQuote: (quote: Quote) => void,
  ): void {
    if (state.lastQuote === null || state.lastQuote.status === 'stale') return
    const staleQuote: Quote = { ...state.lastQuote, status: 'stale' }
    state.lastQuote = staleQuote
    onQuote(staleQuote)
  }

  private clearReconnectTimer(state: SubscriptionState): void {
    if (state.reconnectTimer === null) return
    this.clearTimer(state.reconnectTimer)
    state.reconnectTimer = null
  }

  private clearStaleTimer(state: SubscriptionState): void {
    if (state.staleTimer === null) return
    this.clearTimer(state.staleTimer)
    state.staleTimer = null
  }

  private disposeSocket(socket: KrakenWebSocket): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch {
      // Cleanup must remain best effort when a browser socket is already closed.
    }
  }
}

function mapAssetPair(body: unknown): Instrument {
  const result = unwrapKrakenResult(body, 'AssetPairs')
  const pair = resolveAssetPair(result)
  if (pair === null || pair.altname !== KRAKEN_PAIR.restPair) {
    throw new Error('Unsupported Kraken AssetPairs response')
  }

  return {
    id: KRAKEN_PAIR.instrumentId,
    symbol: KRAKEN_PAIR.instrumentId,
    displayName: KRAKEN_PAIR.instrumentId,
    assetClass: 'crypto',
    currency: 'EUR',
    exchange: 'Kraken',
    providerSymbols: { kraken: KRAKEN_PAIR.restPair },
    providerMetadata: { ...pair },
  }
}

function resolveAssetPair(result: RecordValue): RecordValue | null {
  const byKey = result[KRAKEN_PAIR.restPair]
  if (isRecord(byKey)) return byKey
  for (const value of Object.values(result)) {
    if (isRecord(value) && value.altname === KRAKEN_PAIR.restPair) {
      return value
    }
  }
  return null
}

function mapOhlcCandles(result: RecordValue, restPair: string): Candle[] {
  const rows = resolveOhlcRows(result, restPair)
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Invalid Kraken OHLC response')
  }
  const candles = rows.map(mapOhlcCandle)
  let previousTime = -Infinity
  for (const candle of candles) {
    const time = Date.parse(candle.time)
    if (time <= previousTime) {
      throw new Error('Kraken OHLC data must be in ascending time order')
    }
    previousTime = time
  }
  // The last entry is always the current, still-forming candle. A browser
  // chart must never surface an unconfirmed candle as closed data.
  const closedCandles = candles.slice(0, -1)
  if (closedCandles.length === 0) {
    throw new Error('Invalid Kraken OHLC response')
  }
  return closedCandles
}

function resolveOhlcRows(result: RecordValue, restPair: string): unknown {
  const byKey = result[restPair]
  if (Array.isArray(byKey)) return byKey
  for (const [key, value] of Object.entries(result)) {
    if (key === 'last') continue
    if (Array.isArray(value)) return value
  }
  return null
}

function mapOhlcCandle(value: unknown): Candle {
  if (!Array.isArray(value) || value.length < 7) {
    throw new Error('Invalid Kraken OHLC candle')
  }
  const timestamp = numberValue(value[0])
  const open = numberValue(value[1])
  const high = numberValue(value[2])
  const low = numberValue(value[3])
  const close = numberValue(value[4])
  const volume = numberValue(value[6])
  if (
    timestamp === null ||
    timestamp <= 0 ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null ||
    low <= 0 ||
    high <= 0 ||
    open <= 0 ||
    close <= 0 ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    volume < 0
  ) {
    throw new Error('Invalid Kraken OHLC candle')
  }
  const time = new Date(timestamp * 1000).toISOString()
  return { time, open, high, low, close, volume }
}

function mapTicker(
  instrumentId: InstrumentId,
  value: RecordValue,
): Quote | null {
  const price = numberValue(value.last)
  const change = numberValue(value.change)
  const changePercent = numberValue(value.change_pct)
  const timestamp = stringValue(value.timestamp)
  if (
    price === null ||
    price <= 0 ||
    change === null ||
    changePercent === null ||
    timestamp === null ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    return null
  }
  return {
    instrumentId,
    price,
    change,
    changePercent,
    timestamp,
    status: 'live',
  }
}

function unwrapKrakenResult(body: unknown, label: string): RecordValue {
  if (!isRecord(body)) {
    throw new Error(`Invalid Kraken ${label} response`)
  }
  const errors = body.error
  if (
    !Array.isArray(errors) ||
    errors.some((error) => typeof error !== 'string')
  ) {
    throw new Error(`Invalid Kraken ${label} response`)
  }
  if (errors.length > 0) {
    throw new Error(`Kraken API error: ${errors.join(', ')}`)
  }
  if (!isRecord(body.result)) {
    throw new Error(`Invalid Kraken ${label} response`)
  }
  return body.result
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function positiveOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function defaultWebSocketFactory(url: string): KrakenWebSocket {
  const nativeSocket = new WebSocket(url)
  const socket: KrakenWebSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data) => nativeSocket.send(data),
    close: (code, reason) => nativeSocket.close(code, reason),
  }
  nativeSocket.addEventListener('open', () => socket.onopen?.())
  nativeSocket.addEventListener('message', (event) =>
    socket.onmessage?.({ data: String(event.data) }),
  )
  nativeSocket.addEventListener('error', () => socket.onerror?.())
  nativeSocket.addEventListener('close', () => socket.onclose?.())
  return socket
}
