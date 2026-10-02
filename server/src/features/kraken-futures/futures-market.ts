import { createHash } from 'node:crypto'

export const FUTURES_PRODUCT = 'PF_XBTUSD'
export const FUTURES_INSTRUMENT_ID = 'kraken-futures:PF_XBTUSD'
export const FUTURES_WS_URL = 'wss://futures.kraken.com/ws/v1'
export const MARKET_POLICY_VERSION = 'kraken-futures-ordering-unproven-v2'
export const PAPER_MARKET_QUALITY_POLICY = Object.freeze({
  version: 'snapshot-contiguous-observed.v1',
  sourceGuarantee: 'undocumented',
  eligibility: 'paper_only',
  requirements: [
    'valid instrument metadata',
    'instrument is not suspended',
    'fresh ticker mark and book',
    'book reconstructed from a valid snapshot',
    'observed contiguous book sequence within the epoch',
    'no feed gap, malformed depth, crossed book, or stale market status',
  ],
  exclusions: [
    'provider sequence-delivery guarantee is not established',
    'real exchange execution is unavailable',
    'unknown funding keeps cost accounting incomplete',
  ],
})
const MAX_MESSAGE_BYTES = 256_000
const MAX_BOOK_LEVELS = 5_000

type JsonRecord = Record<string, unknown>
export type MarketFeed = 'trade' | 'book' | 'ticker'
export type MarketStatus =
  | 'connecting'
  | 'syncing'
  | 'live'
  | 'degraded'
  | 'stale'
  | 'disconnected'
  | 'stopped'

export interface InstrumentSpec {
  readonly version: 1
  readonly instrumentId: typeof FUTURES_INSTRUMENT_ID
  readonly venue: 'KrakenDerivatives'
  readonly productId: typeof FUTURES_PRODUCT
  readonly marketType: 'linear_perpetual'
  readonly base: 'BTC'
  readonly quote: 'USD'
  readonly settlement: 'USD'
  readonly quantityUnit: 'BTC'
  readonly contractSize: string
  readonly tickSize: string
  readonly quantityPrecision: number
  readonly minimumQuantity: string
  readonly quantityStep: string
  readonly source: 'live' | 'fixture'
  readonly retrievedAt: number
  readonly metadataHash: string
  readonly eeaRulesVersion: 'kraken-eea-linear-perpetual-2026-09-30'
  readonly entryEligibility: 'eligible' | 'metadata_invalid'
  readonly reason?: string
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object.`)
  return value as JsonRecord
}

function decimal(value: unknown, label: string, allowZero = false): string {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new TypeError(`${label} must be a decimal.`)
  const text = String(value)
  if (
    text.length > 128 ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
  )
    throw new TypeError(`${label} must be a bounded finite decimal.`)
  const [mantissa, exponentText] = text.toLowerCase().split('e')
  const exponent = Number(exponentText ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100)
    throw new RangeError(`${label} exponent is out of range.`)
  const negative = mantissa!.startsWith('-')
  const unsigned = mantissa!.replace(/^[+-]/, '')
  const [whole = '', fraction = ''] = unsigned.split('.')
  const digits = `${whole}${fraction}`
  const point = whole.length + exponent
  let output =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${'0'.repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`
  if (output.includes('.'))
    output = output.replace(/0+$/, '').replace(/\.$/, '')
  output = output.replace(/^0+(?=\d)/, '') || '0'
  if (negative && output !== '0') output = `-${output}`
  if ((!allowZero && output.startsWith('-')) || (output === '0' && !allowZero))
    throw new RangeError(`${label} must be positive.`)
  return output
}

function integer(value: unknown, label: string): number {
  const parsed =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new TypeError(`${label} must be a non-negative safe integer.`)
  return parsed
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Parse provider JSON without first rounding financial numbers to IEEE-754. */
export function decodeProviderJson(
  text: string,
  maxBytes = MAX_MESSAGE_BYTES,
): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5_000_000)
    throw new RangeError('Provider message size limit is invalid.')
  if (Buffer.byteLength(text, 'utf8') > maxBytes)
    throw new RangeError('Provider message exceeds the configured size bound.')
  type SourceContext = { source?: string }
  const decode = JSON.parse as (
    text: string,
    reviver: (
      this: unknown,
      key: string,
      value: unknown,
      context?: SourceContext,
    ) => unknown,
  ) => unknown
  return decode(text, function (_key, value, context) {
    if (typeof value === 'number') {
      const source = context?.source
      if (!source || source.length > 128)
        throw new TypeError('Numeric source lexeme is unavailable or too long.')
      return source
    }
    return value
  })
}

export function marketSubscriptions(): string[] {
  return (['trade', 'book', 'ticker'] as const).map((feed) =>
    JSON.stringify({
      event: 'subscribe',
      feed,
      product_ids: [FUTURES_PRODUCT],
    }),
  )
}

export function validateInstrumentCatalog(
  input: unknown,
  evidence: {
    readonly source: 'live' | 'fixture'
    readonly retrievedAt: number
  },
): InstrumentSpec {
  integer(evidence.retrievedAt, 'retrievedAt')
  const payload = record(input, 'catalog')
  if (
    !Array.isArray(payload.instruments) ||
    payload.instruments.length > 20_000
  )
    throw new TypeError('Catalog instruments must be a bounded array.')
  const matches = payload.instruments.filter(
    (item) => record(item, 'instrument').symbol === FUTURES_PRODUCT,
  )
  if (matches.length !== 1)
    throw new TypeError(
      'Catalog must contain exactly one PF_XBTUSD instrument.',
    )
  const row = record(matches[0], 'instrument')
  const contractSize = decimal(row.contractSize, 'contractSize')
  const tickSize = decimal(row.tickSize, 'tickSize')
  const precision =
    row.contractValueTradePrecision === undefined
      ? undefined
      : integer(row.contractValueTradePrecision, 'contractValueTradePrecision')
  const invalidReason =
    row.type !== 'flexible_futures'
      ? 'Expected the linear multi-collateral flexible_futures contract.'
      : row.pair !== 'BTC:USD' || row.base !== 'BTC' || row.quote !== 'USD'
        ? 'Catalog currency identity does not match BTC/USD.'
        : contractSize !== '1'
          ? 'Catalog contract size is not one BTC per contract.'
          : tickSize !== '1'
            ? 'Catalog price tick conflicts with the configured EEA tick.'
            : precision !== 4
              ? 'Catalog quantity precision conflicts with the EEA lot precision.'
              : row.tradeable !== true || row.isExpired !== false
                ? 'Instrument is not confirmed tradeable and unexpired.'
                : undefined
  const metadata = {
    symbol: row.symbol,
    type: row.type,
    pair: row.pair,
    base: row.base,
    quote: row.quote,
    contractSize,
    tickSize,
    precision,
    tradeable: row.tradeable,
    isExpired: row.isExpired,
  }
  return {
    version: 1,
    instrumentId: FUTURES_INSTRUMENT_ID,
    venue: 'KrakenDerivatives',
    productId: FUTURES_PRODUCT,
    marketType: 'linear_perpetual',
    base: 'BTC',
    quote: 'USD',
    settlement: 'USD',
    quantityUnit: 'BTC',
    contractSize,
    tickSize,
    quantityPrecision: typeof precision === 'number' ? precision : 0,
    minimumQuantity: '0.0001',
    quantityStep: '0.0001',
    source: evidence.source,
    retrievedAt: evidence.retrievedAt,
    metadataHash: hash(metadata),
    eeaRulesVersion: 'kraken-eea-linear-perpetual-2026-09-30',
    entryEligibility: invalidReason ? 'metadata_invalid' : 'eligible',
    ...(invalidReason ? { reason: invalidReason } : {}),
  }
}

export interface FeedContext {
  readonly receivedAt: number
  readonly persistedAt?: number
  readonly epoch: number
}

interface MarketEnvelope {
  readonly productId: typeof FUTURES_PRODUCT
  readonly seq: number
  readonly eventTime: number
  readonly receivedAt: number
  readonly persistedAt: number
  readonly epoch: number
  readonly raw: unknown
}

export interface TradeEvent extends MarketEnvelope {
  readonly type: 'trade'
  readonly uid: string
  readonly side: 'buy' | 'sell'
  readonly tradeType: 'fill' | 'liquidation' | 'termination' | 'block'
  readonly quantityBtc: string
  readonly priceUsd: string
  readonly recovered: boolean
  readonly rawJson?: string
  readonly sequenceIntegrity?: 'monotonic_only_unproven'
}

export interface BookLevel {
  readonly price: string
  readonly quantity: string
}
export interface BookEvent extends MarketEnvelope {
  readonly type: 'book'
  readonly snapshot: boolean
  readonly side?: 'bid' | 'ask'
  readonly price?: string
  readonly quantity?: string
  readonly bids?: readonly BookLevel[]
  readonly asks?: readonly BookLevel[]
  readonly rawJson?: string
  readonly sequenceIntegrity?: 'monotonic_only_unproven'
}

export interface TickerEvent extends MarketEnvelope {
  readonly type: 'ticker'
  readonly last?: string
  readonly bid?: string
  readonly ask?: string
  readonly mark?: string
  readonly index?: string
  readonly suspended: boolean
  readonly funding:
    | { readonly status: 'unknown' }
    | {
        readonly status: 'observed'
        readonly rate: string
        readonly unit: 'provider-unresolved'
      }
  readonly predictedFunding?: string
  readonly rawJson?: string
  readonly sequenceSource?: 'provider' | 'collector_arrival'
}

function checkProduct(item: JsonRecord): void {
  if (item.product_id !== FUTURES_PRODUCT)
    throw new TypeError('Unexpected futures product_id.')
}
function makeEnvelope(
  item: JsonRecord,
  context: FeedContext,
  seq: unknown,
  time: unknown,
): MarketEnvelope {
  const receivedAt = integer(context.receivedAt, 'receivedAt')
  const epoch = integer(context.epoch, 'epoch')
  return {
    productId: FUTURES_PRODUCT,
    seq: integer(seq, 'seq'),
    eventTime: integer(time, 'event time'),
    receivedAt,
    persistedAt: integer(
      context.persistedAt ?? context.receivedAt,
      'persistedAt',
    ),
    epoch,
    raw: item,
  }
}

export function parseTradeMessage(
  value: unknown,
  context: FeedContext,
): TradeEvent {
  const item = record(value, 'trade')
  if (item.feed !== 'trade')
    throw new TypeError(
      'Expected a trade delta, not a snapshot/control message.',
    )
  checkProduct(item)
  if (
    typeof item.uid !== 'string' ||
    item.uid.length < 1 ||
    item.uid.length > 128
  )
    throw new TypeError('Trade UID is missing or invalid.')
  if (item.side !== 'buy' && item.side !== 'sell')
    throw new TypeError('Trade aggressor side is invalid.')
  if (
    !['fill', 'liquidation', 'termination', 'block'].includes(String(item.type))
  )
    throw new TypeError('Trade classification is invalid.')
  return {
    ...makeEnvelope(item, context, item.seq, item.time),
    type: 'trade',
    uid: item.uid,
    side: item.side,
    tradeType: item.type as TradeEvent['tradeType'],
    quantityBtc: decimal(item.qty, 'trade quantity'),
    priceUsd: decimal(item.price, 'trade price'),
    recovered: false,
  }
}

export function parseTradeSnapshot(
  value: unknown,
  context: FeedContext,
): TradeEvent[] {
  const snapshot = record(value, 'trade snapshot')
  if (
    snapshot.feed !== 'trade_snapshot' ||
    snapshot.product_id !== FUTURES_PRODUCT ||
    !Array.isArray(snapshot.trades) ||
    snapshot.trades.length > 10_000
  )
    throw new TypeError(
      'Trade snapshot is invalid or exceeds the warm-up bound.',
    )
  return snapshot.trades.map((item) => ({
    ...parseTradeMessage(item, context),
    recovered: true,
    raw: item,
  }))
}

function level(value: unknown): BookLevel {
  const item = record(value, 'book level')
  return {
    price: decimal(item.price, 'book price'),
    quantity: decimal(item.qty, 'book quantity'),
  }
}
function compareDecimals(a: string, b: string): number {
  const [aw, af = ''] = a.split('.')
  const [bw, bf = ''] = b.split('.')
  const ai = BigInt(aw!),
    bi = BigInt(bw!)
  if (ai !== bi) return ai < bi ? -1 : 1
  const width = Math.max(af.length, bf.length)
  const av = BigInt(af.padEnd(width, '0') || '0')
  const bv = BigInt(bf.padEnd(width, '0') || '0')
  return av === bv ? 0 : av < bv ? -1 : 1
}

export function parseBookMessage(
  value: unknown,
  context: FeedContext,
): BookEvent {
  const item = record(value, 'book')
  checkProduct(item)
  if (item.feed === 'book_snapshot') {
    if (
      !Array.isArray(item.bids) ||
      !Array.isArray(item.asks) ||
      item.bids.length > MAX_BOOK_LEVELS ||
      item.asks.length > MAX_BOOK_LEVELS
    )
      throw new TypeError(
        'Book snapshot levels are invalid or exceed the bound.',
      )
    const bids = item.bids
      .map(level)
      .sort((a, b) => -compareDecimals(a.price, b.price))
    const asks = item.asks
      .map(level)
      .sort((a, b) => compareDecimals(a.price, b.price))
    if (
      bids.some(
        (x, i) => i > 0 && compareDecimals(bids[i - 1]!.price, x.price) === 0,
      ) ||
      asks.some(
        (x, i) => i > 0 && compareDecimals(asks[i - 1]!.price, x.price) === 0,
      )
    )
      throw new TypeError('Book snapshot contains duplicate price levels.')
    if (
      bids.length &&
      asks.length &&
      compareDecimals(bids[0]!.price, asks[0]!.price) >= 0
    )
      throw new TypeError('Book snapshot is crossed or locked.')
    return {
      ...makeEnvelope(item, context, item.seq, item.timestamp),
      type: 'book',
      snapshot: true,
      bids,
      asks,
    }
  }
  if (item.feed !== 'book')
    throw new TypeError('Expected a book snapshot or delta.')
  if (
    item.side !== 'buy' &&
    item.side !== 'sell' &&
    item.side !== 'bid' &&
    item.side !== 'ask'
  )
    throw new TypeError('Book delta side is invalid.')
  return {
    ...makeEnvelope(item, context, item.seq, item.timestamp),
    type: 'book',
    snapshot: false,
    side: item.side === 'buy' || item.side === 'bid' ? 'bid' : 'ask',
    price: decimal(item.price, 'book price'),
    quantity: decimal(item.qty, 'book quantity', true),
  }
}

export function parseTickerMessage(
  value: unknown,
  context: FeedContext,
): TickerEvent {
  const item = record(value, 'ticker')
  if (item.feed !== 'ticker')
    throw new TypeError('Expected ticker feed message.')
  checkProduct(item)
  if (typeof item.suspended !== 'boolean')
    throw new TypeError('Ticker suspended status is required.')
  const optional = (name: string): string | undefined =>
    item[name] === undefined ? undefined : decimal(item[name], `ticker ${name}`)
  const fundingValue = item.funding_rate
  const funding =
    fundingValue === undefined
      ? { status: 'unknown' as const }
      : {
          status: 'observed' as const,
          rate: decimal(fundingValue, 'funding_rate', true),
          unit: 'provider-unresolved' as const,
        }
  return {
    ...makeEnvelope(item, context, item.seq ?? 0, item.time),
    type: 'ticker',
    last: optional('last'),
    bid: optional('bid'),
    ask: optional('ask'),
    mark: optional('markPrice'),
    index: optional('index'),
    suspended: item.suspended === true,
    funding,
    ...(item.funding_rate_prediction === undefined
      ? {}
      : {
          predictedFunding: decimal(
            item.funding_rate_prediction,
            'funding prediction',
            true,
          ),
        }),
  }
}

export interface FuturesSocket {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(message: string): void
  close(): void
}

export interface FuturesCollectorOptions {
  readonly url?: string
  readonly clock: () => number
  readonly random: () => number
  readonly makeSocket: (url: string) => FuturesSocket
  readonly setTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
  readonly persist: (
    event: TradeEvent | BookEvent | TickerEvent,
  ) => void | 'inserted' | 'duplicate'
  readonly persistGap: (gap: {
    feed: MarketFeed
    productId: string
    epoch: number
    expectedSeq?: number
    actualSeq: number
    detectedAt: number
    reason: string
    policyVersion: string
  }) => void
  readonly onTrade?: (event: TradeEvent) => void
  readonly staleAfterMs?: number
  readonly reconnectMinMs?: number
  readonly reconnectMaxMs?: number
  readonly onState?: (state: MarketStatus, reason?: string) => void
}

/** A bounded, single-product public-feed lifecycle with fail-closed book recovery. */
export class KrakenFuturesMarketCollector {
  private readonly options: FuturesCollectorOptions
  private socket: FuturesSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private freshnessTimer: ReturnType<typeof setTimeout> | null = null
  private state: MarketStatus = 'stopped'
  private epoch = 0
  private reconnectAttempt = 0
  private stopped = true
  private bookValid = false
  private bookSequenceContiguous = false
  private bookResnapshotRequested = false
  private readonly bids = new Map<string, string>()
  private readonly asks = new Map<string, string>()
  private lastBookSeq: number | null = null
  private lastBookAt: number | null = null
  private lastTickerAt: number | null = null
  private lastTickerSuspended = true
  private lastTickerMarkAvailable = false
  private lastReceivedAt: number | null = null
  private lastClockSkewMs: number | null = null
  private gapCount = 0
  private rejectedCount = 0
  private persistenceErrorCount = 0
  private sequenceDiscontinuityCount = 0
  private stateReason: string | undefined
  private readonly seqs = new Map<MarketFeed, number>()
  private readonly tradeIds = new Set<string>()
  private readonly limits: { stale: number; min: number; max: number }

  constructor(options: FuturesCollectorOptions) {
    this.options = options
    this.limits = {
      stale: options.staleAfterMs ?? 3_000,
      min: options.reconnectMinMs ?? 500,
      max: Math.min(options.reconnectMaxMs ?? 30_000, 30_000),
    }
    if (
      this.limits.min < 1 ||
      this.limits.max < this.limits.min ||
      this.limits.stale < 1
    )
      throw new RangeError('Invalid futures collector timing bounds.')
  }

  get status(): MarketStatus {
    return this.state
  }
  get book(): {
    readonly valid: boolean
    readonly executableEligible: boolean
    readonly sequenceIntegrity: 'observed_contiguous' | 'invalid_or_unproven'
    readonly qualityPolicy: 'snapshot-contiguous-observed.v1'
    readonly sourceGuarantee: 'undocumented'
    readonly bids: readonly BookLevel[]
    readonly asks: readonly BookLevel[]
    readonly sequence: number | null
    readonly epoch: number
  } {
    return {
      valid: this.bookValid,
      executableEligible:
        this.state === 'live' &&
        this.bookValid &&
        this.bookSequenceContiguous &&
        this.bids.size > 0 &&
        this.asks.size > 0 &&
        !this.lastTickerSuspended &&
        this.lastTickerMarkAvailable &&
        this.lastBookAt !== null &&
        this.lastTickerAt !== null &&
        this.options.clock() - this.lastBookAt <= this.limits.stale &&
        this.options.clock() - this.lastTickerAt <= this.limits.stale,
      sequenceIntegrity:
        this.bookValid && this.bookSequenceContiguous
          ? 'observed_contiguous'
          : 'invalid_or_unproven',
      qualityPolicy: 'snapshot-contiguous-observed.v1',
      sourceGuarantee: 'undocumented',
      bids: [...this.bids]
        .map(([price, quantity]) => ({ price, quantity }))
        .sort((a, b) => -compareDecimals(a.price, b.price)),
      asks: [...this.asks]
        .map(([price, quantity]) => ({ price, quantity }))
        .sort((a, b) => compareDecimals(a.price, b.price)),
      sequence: this.lastBookSeq,
      epoch: this.epoch,
    }
  }
  get metrics(): {
    readonly epoch: number
    readonly reconnectAttempt: number
    readonly lastReceivedAt: number | null
    readonly bookValid: boolean
    readonly tradeUids: number
    readonly bookAgeMs: number | null
    readonly tickerAgeMs: number | null
    readonly clockSkewMs: number | null
    readonly gapCount: number
    readonly rejectedCount: number
    readonly persistenceErrorCount: number
    readonly sequenceDiscontinuityCount: number
  } {
    const now = this.options.clock()
    return {
      epoch: this.epoch,
      reconnectAttempt: this.reconnectAttempt,
      lastReceivedAt: this.lastReceivedAt,
      bookValid: this.bookValid,
      tradeUids: this.tradeIds.size,
      bookAgeMs:
        this.lastBookSeq === null || this.lastBookAt === null
          ? null
          : now - this.lastBookAt,
      tickerAgeMs: this.lastTickerAt === null ? null : now - this.lastTickerAt,
      clockSkewMs: this.lastClockSkewMs,
      gapCount: this.gapCount,
      rejectedCount: this.rejectedCount,
      persistenceErrorCount: this.persistenceErrorCount,
      sequenceDiscontinuityCount: this.sequenceDiscontinuityCount,
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.options.clearTimeout(this.timer)
    if (this.freshnessTimer !== null)
      this.options.clearTimeout(this.freshnessTimer)
    this.timer = null
    this.freshnessTimer = null
    const socket = this.socket
    this.socket = null
    this.bookValid = false
    socket?.close()
    this.setState('stopped')
  }

  /** Invoke from an injected clock/timer; heartbeats never refresh market evidence. */
  tick(): MarketStatus {
    if (this.stopped) return this.state
    const now = this.options.clock()
    const bookStale =
      this.lastBookAt === null || now - this.lastBookAt > this.limits.stale
    const tickerStale =
      this.lastTickerAt === null || now - this.lastTickerAt > this.limits.stale
    if (bookStale || tickerStale || !this.bookValid) {
      if (bookStale) {
        this.bookValid = false
        this.requestBookSnapshot()
      }
      this.setState('stale', 'book_or_ticker_stale')
    } else {
      this.reconnectAttempt = 0
      this.setState('live')
    }
    return this.state
  }

  private setState(state: MarketStatus, reason?: string): void {
    if (this.state === state && this.stateReason === reason) return
    this.state = state
    this.stateReason = reason
    this.options.onState?.(state, reason)
  }

  private connect(): void {
    if (this.stopped) return
    this.epoch += 1
    this.bookValid = false
    this.bookResnapshotRequested = false
    this.lastBookSeq = null
    this.bids.clear()
    this.asks.clear()
    this.seqs.clear()
    this.lastTickerAt = null
    this.lastTickerSuspended = true
    this.lastTickerMarkAvailable = false
    this.setState('connecting')
    try {
      const socket = this.options.makeSocket(this.options.url ?? FUTURES_WS_URL)
      this.socket = socket
      socket.onopen = () => {
        if (this.stopped || this.socket !== socket) return
        this.setState('syncing')
        for (const message of marketSubscriptions()) socket.send(message)
      }
      socket.onmessage = ({ data }) => {
        if (this.stopped || this.socket !== socket) return
        try {
          this.accept(data)
        } catch (error) {
          if (this.stopped) return
          this.rejectedCount += 1
          this.bookValid = false
          this.requestBookSnapshot()
          this.setState(
            'degraded',
            error instanceof Error ? error.message : 'invalid_feed_message',
          )
        }
      }
      socket.onerror = () => this.setState('degraded', 'websocket_error')
      socket.onclose = () => {
        if (this.socket !== socket) return
        this.socket = null
        this.bookValid = false
        this.setState('disconnected', 'connection_closed')
        this.scheduleReconnect()
      }
    } catch (error) {
      this.socket = null
      this.bookValid = false
      this.setState(
        'degraded',
        error instanceof Error ? error.message : 'socket_creation_failed',
      )
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== null) return
    const base = Math.min(
      this.limits.max,
      this.limits.min * 2 ** Math.min(this.reconnectAttempt, 16),
    )
    const random = this.options.random()
    if (!Number.isFinite(random) || random < 0 || random > 1)
      throw new RangeError('Jitter source must be between zero and one.')
    const delay = Math.min(this.limits.max, Math.round(base * (0.5 + random)))
    this.reconnectAttempt += 1
    this.timer = this.options.setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private accept(data: unknown): void {
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : ''
    if (!text) throw new TypeError('Unsupported or empty websocket frame.')
    const value = decodeProviderJson(text)
    const item = record(value, 'websocket message')
    if (item.event === 'error' || String(item.event ?? '').endsWith('_failed'))
      throw new Error(
        `Kraken Futures subscription error: ${String(item.message ?? item.event)}`,
      )
    if (
      item.event === 'subscribed' ||
      item.event === 'info' ||
      item.event === 'pong' ||
      item.feed === 'heartbeat'
    )
      return
    const receivedAt = integer(this.options.clock(), 'receivedAt')
    const context = { receivedAt, persistedAt: receivedAt, epoch: this.epoch }
    if (item.feed === 'trade_snapshot') {
      for (const trade of parseTradeSnapshot(value, context)) {
        const outcome = this.persistRaw(trade, text)
        if (outcome !== 'duplicate') this.lastReceivedAt = receivedAt
      }
      return
    }
    let event: TradeEvent | BookEvent | TickerEvent
    if (item.feed === 'trade')
      event = { ...parseTradeMessage(value, context), rawJson: text }
    else if (item.feed === 'book' || item.feed === 'book_snapshot')
      event = { ...parseBookMessage(value, context), rawJson: text }
    else if (item.feed === 'ticker') {
      const parsed = parseTickerMessage(value, context)
      const previousTicker = this.seqs.get('ticker')
      event = {
        ...parsed,
        seq: item.seq === undefined ? (previousTicker ?? 0) + 1 : parsed.seq,
        sequenceSource:
          item.seq === undefined ? 'collector_arrival' : 'provider',
        rawJson: text,
      }
    } else throw new TypeError('Unsupported futures feed message.')
    const previous = this.seqs.get(event.type)
    if (event.type === 'book' && event.snapshot) {
      this.bids.clear()
      this.asks.clear()
      for (const entry of event.bids ?? [])
        this.bids.set(entry.price, entry.quantity)
      for (const entry of event.asks ?? [])
        this.asks.set(entry.price, entry.quantity)
      this.bookValid = this.bids.size > 0 && this.asks.size > 0
      this.bookSequenceContiguous = this.bookValid
      this.bookResnapshotRequested = false
      this.lastBookSeq = event.seq
      this.lastBookAt = receivedAt
      if (!this.bookValid) {
        this.gapCount += 1
        this.setState('degraded', 'invalid_book_depth_requires_snapshot')
        this.requestBookSnapshot()
      }
      if (!this.bookValid) {
        this.gapCount += 1
        this.setState('degraded', 'invalid_book_depth_requires_snapshot')
        this.requestBookSnapshot()
      }
    } else if (event.type === 'book') {
      const expectedSeq = previous === undefined ? undefined : previous + 1
      if (!this.bookValid) return
      if (expectedSeq === undefined || event.seq <= previous!) {
        this.bookValid = false
        this.gapCount += 1
        this.options.persistGap({
          feed: 'book',
          productId: FUTURES_PRODUCT,
          epoch: this.epoch,
          ...(expectedSeq === undefined ? {} : { expectedSeq }),
          actualSeq: event.seq,
          detectedAt: receivedAt,
          reason: 'book_sequence_regression_requires_fresh_snapshot',
          policyVersion: MARKET_POLICY_VERSION,
        })
        this.setState('degraded', 'book_sequence_gap_requires_snapshot')
        this.requestBookSnapshot()
        return
      }
      if (event.seq > expectedSeq) {
        this.sequenceDiscontinuityCount += 1
        this.bookValid = false
        this.bookSequenceContiguous = false
        this.gapCount += 1
        this.options.persistGap({
          feed: 'book',
          productId: FUTURES_PRODUCT,
          epoch: this.epoch,
          expectedSeq,
          actualSeq: event.seq,
          detectedAt: receivedAt,
          reason: 'book_sequence_gap_requires_fresh_snapshot',
          policyVersion: MARKET_POLICY_VERSION,
        })
        this.setState('degraded', 'book_sequence_gap_requires_snapshot')
        this.requestBookSnapshot()
        return
      }
      const levels = event.side === 'bid' ? this.bids : this.asks
      if (event.quantity === '0') levels.delete(event.price!)
      else levels.set(event.price!, event.quantity!)
      const bestBid = [...this.bids.keys()].sort(
        (a, b) => -compareDecimals(a, b),
      )[0]
      const bestAsk = [...this.asks.keys()].sort(compareDecimals)[0]
      if (
        this.bids.size === 0 ||
        this.asks.size === 0 ||
        (bestBid !== undefined &&
          bestAsk !== undefined &&
          compareDecimals(bestBid, bestAsk) >= 0)
      ) {
        this.bookValid = false
        this.gapCount += 1
        this.options.persistGap({
          feed: 'book',
          productId: FUTURES_PRODUCT,
          epoch: this.epoch,
          expectedSeq: expectedSeq!,
          actualSeq: event.seq,
          detectedAt: receivedAt,
          reason: 'book_delta_would_cross_the_reconstructed_book',
          policyVersion: MARKET_POLICY_VERSION,
        })
        this.setState('degraded', 'invalid_book_depth_requires_snapshot')
        this.requestBookSnapshot()
        return
      }
      if (
        this.bids.size > MAX_BOOK_LEVELS ||
        this.asks.size > MAX_BOOK_LEVELS
      ) {
        this.bookValid = false
        this.gapCount += 1
        this.options.persistGap({
          feed: 'book',
          productId: FUTURES_PRODUCT,
          epoch: this.epoch,
          expectedSeq: expectedSeq!,
          actualSeq: event.seq,
          detectedAt: receivedAt,
          reason: 'reconstructed_book_exceeds_level_bound',
          policyVersion: MARKET_POLICY_VERSION,
        })
        this.setState('degraded', 'book_level_limit_requires_snapshot')
        this.requestBookSnapshot()
        return
      }
      this.lastBookSeq = event.seq
      this.lastBookAt = receivedAt
    } else if (
      event.type === 'trade' &&
      previous !== undefined &&
      event.seq > previous + 1
    ) {
      this.sequenceDiscontinuityCount += 1
    }
    if (
      previous !== undefined &&
      event.seq <= previous &&
      !(event.type === 'book' && event.snapshot)
    ) {
      if (event.type === 'trade' && this.tradeIds.has(event.uid)) return
      throw new Error(`${event.type} sequence is duplicate or out of order.`)
    }
    if (event.type === 'trade') {
      if (this.tradeIds.has(event.uid)) return
      this.tradeIds.add(event.uid)
      if (this.tradeIds.size > 250_000)
        this.tradeIds.delete(this.tradeIds.values().next().value!)
    }
    this.seqs.set(event.type, event.seq)
    this.lastReceivedAt = receivedAt
    this.lastClockSkewMs = receivedAt - event.eventTime
    if (event.type === 'ticker') {
      this.lastTickerAt = receivedAt
      this.lastTickerSuspended = event.suspended
      this.lastTickerMarkAvailable = event.mark !== undefined
    }
    this.scheduleFreshnessCheck()
    try {
      const integrityEvent =
        event.type === 'book' || event.type === 'trade'
          ? { ...event, sequenceIntegrity: 'monotonic_only_unproven' as const }
          : event
      const outcome = this.persistRaw(integrityEvent, text)
      if (event.type === 'trade' && outcome !== 'duplicate' && !event.recovered)
        this.options.onTrade?.(event)
    } catch (error) {
      this.bookValid = false
      this.persistenceErrorCount += 1
      this.stopped = true
      if (this.timer !== null) this.options.clearTimeout(this.timer)
      if (this.freshnessTimer !== null)
        this.options.clearTimeout(this.freshnessTimer)
      this.timer = null
      this.freshnessTimer = null
      this.socket?.close()
      this.socket = null
      this.setState(
        'degraded',
        `market_persistence_failed:${error instanceof Error ? error.message : 'unknown'}`,
      )
      throw error
    }
    this.tick()
  }

  private persistRaw(
    event: TradeEvent | BookEvent | TickerEvent,
    text: string,
  ): void | 'inserted' | 'duplicate' {
    return this.options.persist({
      ...event,
      persistedAt: integer(this.options.clock(), 'persistedAt'),
      rawJson: text,
    })
  }

  private requestBookSnapshot(): void {
    if (!this.socket || this.bookResnapshotRequested) return
    this.bookResnapshotRequested = true
    this.socket.send(
      JSON.stringify({
        event: 'unsubscribe',
        feed: 'book',
        product_ids: [FUTURES_PRODUCT],
      }),
    )
    this.socket.send(
      JSON.stringify({
        event: 'subscribe',
        feed: 'book',
        product_ids: [FUTURES_PRODUCT],
      }),
    )
  }

  private scheduleFreshnessCheck(): void {
    if (this.freshnessTimer !== null)
      this.options.clearTimeout(this.freshnessTimer)
    this.freshnessTimer = this.options.setTimeout(() => {
      this.freshnessTimer = null
      if (!this.stopped) this.tick()
    }, this.limits.stale + 1)
  }
}

/** Trade-derived revisions only; no empty-candle or zero-volume inference. */
