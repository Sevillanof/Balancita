import type {
  Candle,
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../domain/market-data'

const PRODUCT_ID = 'BTC-EUR'
const REST_BASE_URL = 'https://api.exchange.coinbase.com'
const WS_URL = 'wss://ws-feed.exchange.coinbase.com'
const CANDLE_GRANULARITY_SECONDS = 86_400
const MAX_CANDLES_PER_REQUEST = 300
const DEFAULT_STALE_AFTER_MS = 15_000
const DEFAULT_RECONNECT_BASE_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 30_000

export type CoinbaseFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface CoinbaseWebSocket {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type CoinbaseWebSocketFactory = (url: string) => CoinbaseWebSocket

type TimerHandle = ReturnType<typeof globalThis.setTimeout>
type TimerFunction = (handler: () => void, timeout: number) => TimerHandle
type ClearTimerFunction = (handle: TimerHandle) => void

export type CoinbaseMarketDataProviderOptions = {
  fetch?: CoinbaseFetch
  webSocketFactory?: CoinbaseWebSocketFactory
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
  socket: CoinbaseWebSocket | null
  sequence: number | null
  lastQuote: Quote | null
  lastQuoteAt: number | null
  staleTimer: TimerHandle | null
  reconnectTimer: TimerHandle | null
  reconnectAttempt: number
}

type RecordValue = Record<string, unknown>

export class CoinbaseMarketDataProvider implements MarketDataProvider {
  private readonly fetcher: CoinbaseFetch
  private readonly webSocketFactory: CoinbaseWebSocketFactory
  private readonly restBaseUrl: string
  private readonly webSocketUrl: string
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly setTimer: TimerFunction
  private readonly clearTimer: ClearTimerFunction

  constructor(options: CoinbaseMarketDataProviderOptions = {}) {
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
    const product = await this.requestJson(`/products/${PRODUCT_ID}`)
    return [mapProduct(product)]
  }

  async getHistory(instrumentId: InstrumentId): Promise<Candle[]> {
    assertSupportedInstrument(instrumentId)
    const path = `/products/${PRODUCT_ID}/candles?granularity=${CANDLE_GRANULARITY_SECONDS}`
    const response = await this.requestJson(path)

    if (!Array.isArray(response)) {
      throw new Error('Invalid candles response from Coinbase')
    }
    // Coinbase returns newest-first; validate every row, then retain the newest
    // 300 rows locally before sorting the result into chart order.
    const candles = response.map(mapCandle).slice(0, MAX_CANDLES_PER_REQUEST)
    return candles.sort(
      (left, right) => Date.parse(left.time) - Date.parse(right.time),
    )
  }

  subscribe(
    instrumentIds: InstrumentId[],
    onQuote: (quote: Quote) => void,
  ): () => void {
    const uniqueInstrumentIds = [...new Set(instrumentIds)]
    for (const instrumentId of uniqueInstrumentIds) {
      assertSupportedInstrument(instrumentId)
    }
    if (uniqueInstrumentIds.length === 0) return () => undefined

    const state: SubscriptionState = {
      active: true,
      socket: null,
      sequence: null,
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
      throw new Error(`Coinbase HTTP ${response.status} for ${path}`)
    }
    try {
      return await response.json()
    } catch (error) {
      throw new Error(`Invalid Coinbase JSON response for ${path}`, {
        cause: error,
      })
    }
  }

  private connect(
    state: SubscriptionState,
    onQuote: (quote: Quote) => void,
  ): void {
    if (!state.active) return

    let socket: CoinbaseWebSocket
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
          type: 'subscribe',
          product_ids: [PRODUCT_ID],
          channels: ['ticker'],
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
    socket: CoinbaseWebSocket,
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

    if (!isRecord(payload) || payload.type !== 'ticker') return
    if (payload.product_id !== PRODUCT_ID) return

    const sequence = numberValue(payload.sequence)
    const quote = mapTicker(payload)
    if (sequence === null || quote === null) {
      this.handleSocketFailure(state, socket, onQuote)
      return
    }

    if (state.sequence !== null && sequence <= state.sequence) {
      // Duplicate and delayed ticker messages are harmless; do not publish them
      // or treat a feed gap as a socket failure.
      return
    }

    state.sequence = sequence
    state.lastQuote = quote
    state.lastQuoteAt = this.now()
    onQuote(quote)
    this.scheduleStale(state, onQuote)
  }

  private handleSocketFailure(
    state: SubscriptionState,
    socket: CoinbaseWebSocket,
    onQuote: (quote: Quote) => void,
  ): void {
    if (!state.active || state.socket !== socket) return
    state.socket = null
    state.sequence = null
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

  private disposeSocket(socket: CoinbaseWebSocket): void {
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

function mapProduct(value: unknown): Instrument {
  const product = recordValue(value, 'product')
  const id = stringValue(product.id)
  const baseCurrency = stringValue(product.base_currency)
  const quoteCurrency = stringValue(product.quote_currency)
  const displayName = stringValue(product.display_name)
  if (
    id !== PRODUCT_ID ||
    baseCurrency !== 'BTC' ||
    quoteCurrency !== 'EUR' ||
    displayName === null
  ) {
    throw new Error('Invalid Coinbase BTC-EUR product response')
  }

  return {
    id,
    symbol: id,
    displayName,
    assetClass: 'crypto',
    currency: 'EUR',
    exchange: 'Coinbase Exchange',
    providerSymbols: { coinbase: id },
    providerMetadata: { ...product },
  }
}

function mapCandle(value: unknown): Candle {
  if (!Array.isArray(value) || value.length < 6) {
    throw new Error('Invalid candle response from Coinbase')
  }
  const timestamp = numberValue(value[0])
  const low = numberValue(value[1])
  const high = numberValue(value[2])
  const open = numberValue(value[3])
  const close = numberValue(value[4])
  const volume = numberValue(value[5])
  if (
    timestamp === null ||
    timestamp <= 0 ||
    low === null ||
    high === null ||
    open === null ||
    close === null ||
    volume === null ||
    low <= 0 ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    volume < 0
  ) {
    throw new Error('Invalid candle response from Coinbase')
  }
  const time = new Date(timestamp * 1000).toISOString()
  return { time, open, high, low, close, volume }
}

function mapTicker(value: RecordValue): Quote | null {
  const price = numberValue(value.price)
  const open24h = numberValue(value.open_24h)
  const timestamp = stringValue(value.time)
  if (
    price === null ||
    price <= 0 ||
    open24h === null ||
    open24h <= 0 ||
    timestamp === null ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    return null
  }
  const change = price - open24h
  return {
    instrumentId: PRODUCT_ID,
    price,
    change,
    changePercent: (change / open24h) * 100,
    timestamp,
    status: 'live',
  }
}

function assertSupportedInstrument(instrumentId: InstrumentId): void {
  if (instrumentId !== PRODUCT_ID) {
    throw new Error(
      `Unsupported instrument for Coinbase market data: ${instrumentId}`,
    )
  }
}

function recordValue(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`Invalid Coinbase ${label} response`)
  return value
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

function defaultWebSocketFactory(url: string): CoinbaseWebSocket {
  const nativeSocket = new WebSocket(url)
  const socket: CoinbaseWebSocket = {
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
