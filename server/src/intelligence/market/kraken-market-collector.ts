import { type TimestampMs, type MarketDataEnvelope } from '../contracts.ts'
import { deriveDataFreshness } from '../slis.ts'
import {
  invalid,
  isRecord,
  issue,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.ts'
import { MarketStore, type ObservationInsertResult } from './market-store.ts'
import {
  KRAKEN_MARKET_SOURCE,
  KRAKEN_REST_PAIR,
  KRAKEN_WS_SYMBOL,
} from './market-sources.ts'
import {
  validateNormalizedMarketPayload,
  type NormalizedMarketPayload,
  type TradeSide,
} from './market-payload.ts'

const SOURCE = KRAKEN_MARKET_SOURCE
const INSTRUMENT = 'BTC-EUR' as const
const DEFAULT_REST_BASE_URL = 'https://api.kraken.com/0'
const DEFAULT_CATCH_UP_MAX_ATTEMPTS = 3
const DEFAULT_CATCH_UP_BACKOFF_MS = 250

type TimerId = number | ReturnType<typeof setTimeout>

export interface KrakenSocket {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(message: string): void
  close(): void
}

export interface KrakenRejection {
  readonly code: string
  readonly message: string
  readonly issues?: readonly ValidationIssue[]
}

export type KrakenCollectorStatus =
  'connecting' | 'connected' | 'reconnecting' | 'stale' | 'stopped'

export interface KrakenCatchUpTrade {
  readonly price: number
  readonly qty: number
  readonly side: TradeSide
  readonly tradeId: number
  readonly eventTime: TimestampMs
  readonly orderType?: 'limit' | 'market'
}

export interface KrakenCatchUpRequest {
  readonly pair: string
  readonly since: number
  readonly until: number
  readonly fromTradeId: number
  readonly toTradeId: number
}

export interface KrakenCatchUpResult {
  readonly trades: readonly KrakenCatchUpTrade[]
  readonly last?: string
}

export interface KrakenCatchUpClient {
  fetchTrades(request: KrakenCatchUpRequest): Promise<KrakenCatchUpResult>
}

export interface KrakenCatchUpFetch {
  (input: string, init?: RequestInit): Promise<Response>
}

export interface KrakenMarketCollectorOptions {
  readonly store: MarketStore
  readonly wsUrl: string
  readonly staleAfterMs: number
  readonly reconnectMinMs: number
  readonly reconnectMaxMs: number
  readonly clock: () => number
  readonly websocketFactory?: (url: string) => KrakenSocket
  readonly setTimeout?: (callback: () => void, delay: number) => number
  readonly clearTimeout?: (timer: number) => void
  readonly random?: () => number
  readonly jitterRatio?: number
  readonly onRejected?: (rejection: KrakenRejection) => void
  readonly onPersisted?: (result: ObservationInsertResult) => void
  readonly catchUpClient?: KrakenCatchUpClient
  readonly fetch?: KrakenCatchUpFetch
  readonly restBaseUrl?: string
  readonly catchUpMaxAttempts?: number
  readonly catchUpBackoffMs?: number
}

export class KrakenMarketCollector {
  readonly source = SOURCE
  readonly instrumentId = INSTRUMENT

  private readonly store: MarketStore
  private readonly wsUrl: string
  private readonly staleAfterMs: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly clock: () => number
  private readonly websocketFactory: (url: string) => KrakenSocket
  private readonly setTimer: (callback: () => void, delay: number) => TimerId
  private readonly clearTimer: (timer: TimerId) => void
  private readonly random: () => number
  private readonly jitterRatio: number
  private readonly onRejected?: (rejection: KrakenRejection) => void
  private readonly onPersisted?: (result: ObservationInsertResult) => void
  private readonly catchUpClient: KrakenCatchUpClient
  private readonly catchUpMaxAttempts: number
  private readonly catchUpBackoffMs: number
  private readonly listeners = new Set<() => void>()
  private readonly catchUpTimers = new Set<TimerId>()
  private socket: KrakenSocket | null = null
  private reconnectTimer: TimerId | null = null
  private staleTimer: TimerId | null = null
  private reconnectAttempt = 0
  private started = false
  private failureHandled = false
  private connectionRevision = 0
  private status: KrakenCollectorStatus = 'stopped'

  constructor(options: KrakenMarketCollectorOptions) {
    this.store = options.store
    this.wsUrl = options.wsUrl
    this.staleAfterMs = options.staleAfterMs
    this.reconnectMinMs = options.reconnectMinMs
    this.reconnectMaxMs = options.reconnectMaxMs
    this.clock = options.clock
    this.websocketFactory =
      options.websocketFactory ??
      ((url) => new globalThis.WebSocket(url) as unknown as KrakenSocket)
    this.setTimer =
      options.setTimeout ??
      ((callback, delay) => setTimeout(callback, delay) as unknown as TimerId)
    this.clearTimer =
      options.clearTimeout === undefined
        ? (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
        : (timer) => options.clearTimeout?.(timer as number)
    this.random = options.random ?? (() => 0.5)
    this.jitterRatio = options.jitterRatio ?? 0
    this.onRejected = options.onRejected
    this.onPersisted = options.onPersisted
    this.catchUpClient =
      options.catchUpClient ??
      createKrakenCatchUpClient({
        restBaseUrl: options.restBaseUrl ?? DEFAULT_REST_BASE_URL,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    this.catchUpMaxAttempts = positiveOrDefault(
      options.catchUpMaxAttempts,
      DEFAULT_CATCH_UP_MAX_ATTEMPTS,
    )
    this.catchUpBackoffMs = positiveOrDefault(
      options.catchUpBackoffMs,
      DEFAULT_CATCH_UP_BACKOFF_MS,
    )
  }

  start(instrumentId: string): void {
    if (instrumentId !== INSTRUMENT) {
      throw new Error('Only BTC-EUR is supported by KrakenMarketCollector.')
    }
    if (this.started) return
    this.started = true
    this.status = 'connecting'
    this.notify()
    this.reconnectAttempt = 0
    this.failureHandled = false
    this.openSocket()
  }

  stop(): void {
    this.started = false
    this.status = 'stopped'
    this.notify()
    this.clearReconnectTimer()
    this.clearStaleTimer()
    this.clearCatchUpTimers()
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    this.detach(socket)
    socket.close()
  }

  getStatus(): KrakenCollectorStatus {
    return this.status
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  refreshStale(): void {
    this.store.markStale(
      SOURCE,
      INSTRUMENT,
      this.clock() as TimestampMs,
      this.staleAfterMs,
    )
    this.status =
      this.store.getCursor(SOURCE, INSTRUMENT)?.status === 'stale'
        ? 'stale'
        : 'connected'
    this.notify()
  }

  private openSocket(): void {
    if (!this.started) return
    this.clearReconnectTimer()
    this.failureHandled = false
    this.connectionRevision = this.store.beginConnection(
      SOURCE,
      INSTRUMENT,
      this.clock() as TimestampMs,
    )
    this.status = 'connecting'
    this.notify()
    try {
      const socket = this.websocketFactory(this.wsUrl)
      this.socket = socket
      socket.onopen = () => this.handleOpen(socket)
      socket.onmessage = (event) => this.handleMessage(socket, event.data)
      socket.onerror = () => this.handleFailure(socket)
      socket.onclose = () => this.handleFailure(socket)
    } catch (error) {
      this.report({
        code: 'socket_open_failed',
        message:
          error instanceof Error ? error.message : 'Socket creation failed.',
      })
      this.handleFailure(null)
    }
  }

  private handleOpen(socket: KrakenSocket): void {
    if (!this.started || this.socket !== socket) return
    this.reconnectAttempt = 0
    this.status = 'connected'
    this.notify()
    try {
      socket.send(
        JSON.stringify({
          method: 'subscribe',
          params: {
            channel: 'trade',
            symbol: [KRAKEN_WS_SYMBOL],
            snapshot: true,
          },
        }),
      )
    } catch {
      this.handleFailure(socket)
    }
  }

  private handleMessage(socket: KrakenSocket, data: unknown): void {
    if (!this.started || this.socket !== socket) return
    if (typeof data !== 'string') {
      this.report({
        code: 'invalid_message',
        message: 'Kraken message must be JSON text.',
      })
      this.handleFailure(socket)
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(data) as unknown
    } catch {
      this.report({
        code: 'invalid_json',
        message: 'Kraken message is not valid JSON.',
      })
      this.handleFailure(socket)
      return
    }
    if (!isRecord(raw)) {
      this.reject('invalid_message', 'Kraken message must be an object.')
      this.handleFailure(socket)
      return
    }
    // Subscription acknowledgements and pong/status frames carry no channel.
    if (raw.channel === undefined || raw.channel !== 'trade') return
    if (raw.type !== 'snapshot' && raw.type !== 'update') return
    if (!Array.isArray(raw.data)) {
      this.reject('invalid_payload', 'Kraken trade data must be an array.')
      this.handleFailure(socket)
      return
    }

    for (const item of raw.data) {
      if (!isRecord(item)) {
        this.reject('invalid_payload', 'Kraken trade entry must be an object.')
        this.handleFailure(socket)
        return
      }
      if (item.symbol !== KRAKEN_WS_SYMBOL) {
        this.reject(
          'unsupported_instrument',
          `Only ${KRAKEN_WS_SYMBOL} is supported.`,
        )
        continue
      }
      const parsed = parseTrade(item)
      if (!parsed.valid) {
        this.reject(
          'invalid_payload',
          'Kraken trade payload failed validation.',
          parsed.issues,
        )
        continue
      }
      this.handleTrade(parsed.value.payload, parsed.value.eventTime)
    }
  }

  private handleTrade(
    payload: NormalizedMarketPayload & { type: 'trade' },
    eventTime: TimestampMs,
  ): void {
    const cursor = this.store.getCursor(SOURCE, INSTRUMENT)
    const previousTradeId = cursor?.lastTradeId
    if (previousTradeId !== undefined && payload.tradeId <= previousTradeId) {
      this.reject(
        'trade_out_of_order',
        'Trade id is duplicate or out of order.',
      )
      return
    }
    const envelope = this.envelope(payload, eventTime)
    if (envelope === null) return
    const result = this.persist(envelope)
    if (result === null) return
    if (
      previousTradeId !== undefined &&
      payload.tradeId > previousTradeId + 1
    ) {
      const since = cursor?.lastEventTime ?? eventTime
      this.store.recordGap({
        source: SOURCE,
        instrumentId: INSTRUMENT,
        prevSequence: previousTradeId,
        currentSequence: payload.tradeId,
        detectedAt: envelope.receivedTime,
        evidence: {
          kind: 'trade_id',
          channel: 'trade',
          connectionRevision: this.connectionRevision,
        },
      })
      this.startCatchUp({
        pair: KRAKEN_REST_PAIR,
        since,
        until: eventTime,
        fromTradeId: previousTradeId,
        toTradeId: payload.tradeId,
      })
    }
    this.updateCursor(envelope, payload.tradeId, payload.tradeId)
    this.scheduleStale(envelope)
  }

  private startCatchUp(request: KrakenCatchUpRequest): void {
    void this.attemptCatchUp(request, 0)
  }

  private async attemptCatchUp(
    request: KrakenCatchUpRequest,
    attempt: number,
  ): Promise<void> {
    try {
      const result = await this.catchUpClient.fetchTrades(request)
      if (!this.started) return
      const filled = this.persistCatchUpTrades(request, result.trades)
      const missing = missingTradeIds(request, filled)
      if (missing.length > 0) {
        this.reject(
          'catch_up_unresolved',
          `Kraken catch-up did not resolve trade ids ${missing.join(', ')}.`,
        )
      }
    } catch (error) {
      if (attempt + 1 < this.catchUpMaxAttempts) {
        const delay = this.catchUpBackoffMs * 2 ** attempt
        const timer = this.setTimer(() => {
          this.catchUpTimers.delete(timer)
          void this.attemptCatchUp(request, attempt + 1)
        }, delay)
        this.catchUpTimers.add(timer)
        return
      }
      this.reject(
        'catch_up_unresolved',
        `Kraken catch-up failed after ${attempt + 1} attempts: ${
          error instanceof Error ? error.message : 'unknown error'
        }.`,
      )
    }
  }

  private persistCatchUpTrades(
    request: KrakenCatchUpRequest,
    trades: readonly KrakenCatchUpTrade[],
  ): number[] {
    const filled: number[] = []
    const ordered = [...trades].sort(
      (left, right) => left.tradeId - right.tradeId,
    )
    for (const trade of ordered) {
      if (
        trade.tradeId <= request.fromTradeId ||
        trade.tradeId >= request.toTradeId ||
        trade.eventTime < request.since ||
        trade.eventTime > request.until
      ) {
        continue
      }
      const payload = validateNormalizedMarketPayload({
        type: 'trade',
        productId: INSTRUMENT,
        tradeId: trade.tradeId,
        sequence: trade.tradeId,
        price: trade.price,
        qty: trade.qty,
        side: trade.side,
        ...(trade.orderType === undefined
          ? {}
          : { orderType: trade.orderType }),
      })
      if (!payload.valid) continue
      const envelope = this.envelope(payload.value, trade.eventTime)
      if (envelope === null) continue
      if (this.persist(envelope) === null) continue
      filled.push(trade.tradeId)
    }
    return filled
  }

  private envelope(
    payload: NormalizedMarketPayload,
    eventTime: TimestampMs,
  ): MarketDataEnvelope<NormalizedMarketPayload> | null {
    const receivedTime = this.clock() as TimestampMs
    const displayTime = receivedTime
    const freshness = deriveDataFreshness({
      eventTime,
      displayTime,
      staleAfterMs: this.staleAfterMs,
      clockSkewPolicy: 'reject',
    })
    if (!freshness.valid) {
      this.reject(
        'invalid_time',
        'Kraken event time failed freshness validation.',
        freshness.issues,
      )
      return null
    }
    return {
      source: SOURCE,
      symbol: INSTRUMENT,
      instrumentId: INSTRUMENT,
      eventTime,
      receivedTime,
      displayTime,
      sequence: payload.sequence,
      payload,
      status: freshness.value.isStale ? 'stale' : 'live',
      freshness: freshness.value,
    }
  }

  private persist(
    envelope: MarketDataEnvelope<NormalizedMarketPayload>,
  ): ObservationInsertResult | null {
    try {
      const result = this.store.insertObservation(
        envelope,
        envelope.receivedTime,
      )
      this.onPersisted?.(result)
      this.status = envelope.status === 'stale' ? 'stale' : 'connected'
      this.notify()
      return result
    } catch (error) {
      this.reject(
        'persistence_rejected',
        error instanceof Error
          ? error.message
          : 'Market observation was rejected.',
        error instanceof Error && 'issues' in error
          ? (error.issues as readonly ValidationIssue[])
          : undefined,
      )
      return null
    }
  }

  private updateCursor(
    envelope: MarketDataEnvelope<NormalizedMarketPayload>,
    sequence: number,
    tradeId: number,
  ): void {
    this.store.updateCursor({
      source: SOURCE,
      instrumentId: INSTRUMENT,
      lastSequence: sequence,
      lastTradeId: tradeId,
      status: envelope.status,
      lastEventTime: envelope.eventTime,
      freshnessAgeMs: envelope.freshness.ageMs,
      updatedAt: envelope.receivedTime,
    })
  }

  private scheduleStale(
    envelope: MarketDataEnvelope<NormalizedMarketPayload>,
  ): void {
    this.clearStaleTimer()
    const dueAt = envelope.eventTime + this.staleAfterMs + 1
    const delay = Math.max(1, dueAt - this.clock())
    this.staleTimer = this.setTimer(() => {
      this.staleTimer = null
      this.refreshStale()
    }, delay)
  }

  private handleFailure(socket: KrakenSocket | null): void {
    if (!this.started || this.failureHandled) return
    if (socket !== null && this.socket !== socket) return
    this.failureHandled = true
    const current = this.socket
    this.socket = null
    if (current !== null) {
      this.detach(current)
      current.close()
    }
    this.store.markStreamStale(SOURCE, INSTRUMENT, this.clock() as TimestampMs)
    this.status = 'reconnecting'
    this.notify()
    if (this.reconnectTimer !== null) return
    const baseDelay = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * 2 ** this.reconnectAttempt,
    )
    this.reconnectAttempt += 1
    const jitter = baseDelay * this.jitterRatio * (this.random() * 2 - 1)
    const delay = Math.max(
      0,
      Math.round(Math.min(this.reconnectMaxMs, baseDelay + jitter)),
    )
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null
      this.failureHandled = false
      this.openSocket()
    }, delay)
  }

  private detach(socket: KrakenSocket): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearStaleTimer(): void {
    if (this.staleTimer === null) return
    this.clearTimer(this.staleTimer)
    this.staleTimer = null
  }

  private clearCatchUpTimers(): void {
    for (const timer of this.catchUpTimers) this.clearTimer(timer)
    this.catchUpTimers.clear()
  }

  private reject(
    code: string,
    message: string,
    issues?: readonly ValidationIssue[],
  ): void {
    this.report({ code, message, ...(issues === undefined ? {} : { issues }) })
  }

  private report(rejection: KrakenRejection): void {
    this.onRejected?.(rejection)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

function missingTradeIds(
  request: KrakenCatchUpRequest,
  filled: readonly number[],
): number[] {
  const present = new Set(filled)
  const missing: number[] = []
  for (
    let tradeId = request.fromTradeId + 1;
    tradeId < request.toTradeId;
    tradeId += 1
  ) {
    if (!present.has(tradeId)) missing.push(tradeId)
  }
  return missing
}

function parseTrade(input: Record<string, unknown>): ValidationResult<{
  payload: NormalizedMarketPayload & { type: 'trade' }
  eventTime: TimestampMs
}> {
  const eventTime = parseKrakenTime(input.timestamp, 'timestamp')
  const tradeId = parseSafeInteger(input.trade_id, 'trade_id')
  const price = parsePositiveNumber(input.price, 'price')
  const qty = parsePositiveNumber(input.qty, 'qty')
  const side = parseSide(input.side)
  const orderType = parseOrderType(input.ord_type)
  const issues: ValidationIssue[] = [
    ...(!eventTime.valid ? eventTime.issues : []),
    ...(!tradeId.valid ? tradeId.issues : []),
    ...(!price.valid ? price.issues : []),
    ...(!qty.valid ? qty.issues : []),
    ...(!side.valid ? side.issues : []),
    ...(!orderType.valid ? orderType.issues : []),
  ]
  if (
    !eventTime.valid ||
    !tradeId.valid ||
    !price.valid ||
    !qty.valid ||
    !side.valid ||
    !orderType.valid
  ) {
    return invalid(issues)
  }
  const validation = validateNormalizedMarketPayload({
    type: 'trade',
    productId: 'BTC-EUR',
    tradeId: tradeId.value,
    sequence: tradeId.value,
    price: price.value,
    qty: qty.value,
    side: side.value,
    ...(orderType.value === undefined ? {} : { orderType: orderType.value }),
  })
  return validation.valid
    ? {
        valid: true as const,
        value: {
          payload: validation.value as NormalizedMarketPayload & {
            type: 'trade'
          },
          eventTime: eventTime.value,
        },
      }
    : invalid(validation.issues)
}

export function createKrakenCatchUpClient(options: {
  readonly restBaseUrl: string
  readonly fetch?: KrakenCatchUpFetch
}): KrakenCatchUpClient {
  const fetcher =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  return {
    async fetchTrades(
      request: KrakenCatchUpRequest,
    ): Promise<KrakenCatchUpResult> {
      const sinceSeconds = Math.floor(request.since / 1000)
      const path = `/public/Trades?pair=${encodeURIComponent(
        request.pair,
      )}&since=${sinceSeconds}`
      const response = await fetcher(`${options.restBaseUrl}${path}`, {
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        throw new Error(`Kraken HTTP ${response.status} for /public/Trades`)
      }
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        throw new Error('Invalid Kraken JSON response for /public/Trades', {
          cause: error,
        })
      }
      return parseTradesResponse(body, request.pair)
    },
  }
}

export function parseTradesResponse(
  body: unknown,
  pair: string,
): KrakenCatchUpResult {
  if (!isRecord(body) || !Array.isArray(body.error)) {
    throw new Error('Invalid Kraken Trades response.')
  }
  const errors = body.error.filter(
    (entry): entry is string => typeof entry === 'string',
  )
  if (errors.length > 0) {
    throw new Error(`Kraken API error: ${errors.join(', ')}`)
  }
  if (!isRecord(body.result)) {
    throw new Error('Invalid Kraken Trades response.')
  }
  const rows = resolveTradeRows(body.result, pair)
  const trades = rows.map(parseRestTradeRow)
  const last = body.result.last
  return {
    trades,
    ...(typeof last === 'string' ? { last } : {}),
  }
}

function resolveTradeRows(
  result: Record<string, unknown>,
  pair: string,
): unknown[] {
  const direct = result[pair]
  if (Array.isArray(direct)) return direct
  for (const [key, value] of Object.entries(result)) {
    if (key === 'last') continue
    if (Array.isArray(value)) return value
  }
  return []
}

function parseRestTradeRow(row: unknown): KrakenCatchUpTrade {
  if (Array.isArray(row)) {
    const price = parsePositiveNumber(row[0], 'price')
    const qty = parsePositiveNumber(row[1], 'qty')
    const eventTime = parseEpochSeconds(row[2], 'time')
    const side = parseRestSide(row[3])
    const orderType = parseRestOrderType(row[4])
    const tradeId = parseSafeInteger(row[6], 'trade_id')
    if (
      !price.valid ||
      !qty.valid ||
      !eventTime.valid ||
      !side.valid ||
      !orderType.valid ||
      !tradeId.valid
    ) {
      throw new Error('Invalid Kraken trade row.')
    }
    return {
      price: price.value,
      qty: qty.value,
      side: side.value,
      tradeId: tradeId.value,
      eventTime: eventTime.value,
      ...(orderType.value === undefined ? {} : { orderType: orderType.value }),
    }
  }
  if (isRecord(row)) {
    const price = parsePositiveNumber(row.price, 'price')
    const qty = parsePositiveNumber(row.volume ?? row.qty, 'qty')
    const eventTime = parseEpochSeconds(row.time, 'time')
    const side = parseRestSide(row.type ?? row.side)
    const orderType = parseRestOrderType(row.ordertype ?? row.order_type)
    const tradeId = parseSafeInteger(row.trade_id ?? row.tradeId, 'trade_id')
    if (
      !price.valid ||
      !qty.valid ||
      !eventTime.valid ||
      !side.valid ||
      !orderType.valid ||
      !tradeId.valid
    ) {
      throw new Error('Invalid Kraken trade row.')
    }
    return {
      price: price.value,
      qty: qty.value,
      side: side.value,
      tradeId: tradeId.value,
      eventTime: eventTime.value,
      ...(orderType.value === undefined ? {} : { orderType: orderType.value }),
    }
  }
  throw new Error('Invalid Kraken trade row.')
}

function parseKrakenTime(
  value: unknown,
  path: string,
): ValidationResult<TimestampMs> {
  if (typeof value !== 'string' || value.trim() === '') {
    return invalid([
      issue(
        'invalid_timestamp',
        path,
        'Kraken event time must be a valid ISO 8601 timestamp.',
      ),
    ])
  }
  // Kraken reports microsecond precision; Date.parse only resolves
  // milliseconds, so trim any fractional digits beyond three.
  const normalized = value.replace(/(\.\d{3})\d+/, '$1')
  const timestamp = Date.parse(normalized)
  return Number.isSafeInteger(timestamp) && timestamp >= 0
    ? { valid: true as const, value: timestamp as TimestampMs }
    : invalid([
        issue(
          'invalid_timestamp',
          path,
          'Kraken event time must be a valid ISO 8601 timestamp.',
        ),
      ])
}

function parseEpochSeconds(
  value: unknown,
  path: string,
): ValidationResult<TimestampMs> {
  const seconds = typeof value === 'string' ? Number(value) : value
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return invalid([
      issue(
        'invalid_timestamp',
        path,
        'Kraken trade time must be a non-negative epoch value.',
      ),
    ])
  }
  const milliseconds = seconds > 1e12 ? seconds : seconds * 1000
  return Number.isSafeInteger(Math.round(milliseconds))
    ? { valid: true as const, value: Math.round(milliseconds) as TimestampMs }
    : invalid([
        issue(
          'invalid_timestamp',
          path,
          'Kraken trade time must resolve to safe epoch milliseconds.',
        ),
      ])
}

function parseSide(value: unknown): ValidationResult<TradeSide> {
  return value === 'buy' || value === 'sell'
    ? { valid: true as const, value }
    : invalid([
        issue('invalid_side', 'side', 'Kraken trade side must be buy or sell.'),
      ])
}

function parseRestSide(value: unknown): ValidationResult<TradeSide> {
  if (value === 'buy' || value === 'sell') {
    return { valid: true as const, value }
  }
  if (value === 'b') return { valid: true as const, value: 'buy' }
  if (value === 's') return { valid: true as const, value: 'sell' }
  return invalid([
    issue('invalid_side', 'side', 'Kraken trade side must be buy or sell.'),
  ])
}

function parseOrderType(
  value: unknown,
): ValidationResult<'limit' | 'market' | undefined> {
  if (value === undefined) return { valid: true as const, value: undefined }
  return value === 'limit' || value === 'market'
    ? { valid: true as const, value }
    : invalid([
        issue(
          'invalid_order_type',
          'ord_type',
          'Kraken order type must be limit or market.',
        ),
      ])
}

function parseRestOrderType(
  value: unknown,
): ValidationResult<'limit' | 'market' | undefined> {
  if (value === undefined) return { valid: true as const, value: undefined }
  if (value === 'limit' || value === 'l') {
    return { valid: true as const, value: 'limit' }
  }
  if (value === 'market' || value === 'm') {
    return { valid: true as const, value: 'market' }
  }
  return invalid([
    issue(
      'invalid_order_type',
      'ordertype',
      'Kraken order type must be limit or market.',
    ),
  ])
}

function parseSafeInteger(
  value: unknown,
  path: string,
): ValidationResult<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { valid: true as const, value }
    : invalid([
        issue(
          'invalid_sequence',
          path,
          'Value must be a non-negative safe integer.',
        ),
      ])
}

function parsePositiveNumber(
  value: unknown,
  path: string,
): ValidationResult<number> {
  const number =
    typeof value === 'string' || typeof value === 'number'
      ? Number(value)
      : Number.NaN
  return Number.isFinite(number) && number > 0
    ? { valid: true as const, value: number }
    : invalid([
        issue(
          path === 'price' ? 'invalid_price' : 'invalid_payload_number',
          path,
          'Value must be finite and positive.',
        ),
      ])
}

function positiveOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback
}
