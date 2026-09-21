import { type TimestampMs, type MarketDataEnvelope } from '../contracts.ts'
import { deriveDataFreshness } from '../slis.ts'
import {
  invalid,
  isRecord,
  issue,
  valid,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.ts'
import { MarketStore, type ObservationInsertResult } from './market-store.ts'
import {
  validateNormalizedMarketPayload,
  type NormalizedMarketPayload,
} from './market-payload.ts'

const SOURCE = 'coinbase_exchange'
const INSTRUMENT = 'BTC-EUR' as const
type TimerId = number | ReturnType<typeof setTimeout>

export interface CoinbaseSocket {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(message: string): void
  close(): void
}

export interface CoinbaseRejection {
  readonly code: string
  readonly message: string
  readonly issues?: readonly ValidationIssue[]
}

export interface CoinbaseMarketCollectorOptions {
  readonly store: MarketStore
  readonly wsUrl: string
  readonly staleAfterMs: number
  readonly reconnectMinMs: number
  readonly reconnectMaxMs: number
  readonly clock: () => number
  readonly websocketFactory?: (url: string) => CoinbaseSocket
  readonly setTimeout?: (callback: () => void, delay: number) => number
  readonly clearTimeout?: (timer: number) => void
  readonly random?: () => number
  readonly jitterRatio?: number
  readonly onRejected?: (rejection: CoinbaseRejection) => void
  readonly onPersisted?: (result: ObservationInsertResult) => void
}

export class CoinbaseMarketCollector {
  readonly source = SOURCE
  readonly instrumentId = INSTRUMENT

  private readonly store: MarketStore
  private readonly wsUrl: string
  private readonly staleAfterMs: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly clock: () => number
  private readonly websocketFactory: (url: string) => CoinbaseSocket
  private readonly setTimer: (callback: () => void, delay: number) => TimerId
  private readonly clearTimer: (timer: TimerId) => void
  private readonly random: () => number
  private readonly jitterRatio: number
  private readonly onRejected?: (rejection: CoinbaseRejection) => void
  private readonly onPersisted?: (result: ObservationInsertResult) => void
  private socket: CoinbaseSocket | null = null
  private reconnectTimer: TimerId | null = null
  private staleTimer: TimerId | null = null
  private reconnectAttempt = 0
  private started = false
  private failureHandled = false
  private tickerSequence: number | undefined
  private heartbeatSequence: number | undefined
  private connectionRevision = 0

  constructor(options: CoinbaseMarketCollectorOptions) {
    this.store = options.store
    this.wsUrl = options.wsUrl
    this.staleAfterMs = options.staleAfterMs
    this.reconnectMinMs = options.reconnectMinMs
    this.reconnectMaxMs = options.reconnectMaxMs
    this.clock = options.clock
    this.websocketFactory =
      options.websocketFactory ??
      ((url) => new globalThis.WebSocket(url) as unknown as CoinbaseSocket)
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
  }

  start(instrumentId: string): void {
    if (instrumentId !== INSTRUMENT) {
      throw new Error('Only BTC-EUR is supported by CoinbaseMarketCollector.')
    }
    if (this.started) return
    this.started = true
    this.reconnectAttempt = 0
    this.failureHandled = false
    this.openSocket()
  }

  stop(): void {
    this.started = false
    this.clearReconnectTimer()
    this.clearStaleTimer()
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    this.detach(socket)
    socket.close()
  }

  refreshStale(): void {
    this.store.markStale(
      SOURCE,
      INSTRUMENT,
      this.clock() as TimestampMs,
      this.staleAfterMs,
    )
  }

  private openSocket(): void {
    if (!this.started) return
    this.clearReconnectTimer()
    this.failureHandled = false
    this.tickerSequence = undefined
    this.heartbeatSequence = undefined
    this.connectionRevision = this.store.beginConnection(
      SOURCE,
      INSTRUMENT,
      this.clock() as TimestampMs,
    )
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

  private handleOpen(socket: CoinbaseSocket): void {
    if (!this.started || this.socket !== socket) return
    this.reconnectAttempt = 0
    try {
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          product_ids: [INSTRUMENT],
          channels: ['ticker', 'heartbeat'],
        }),
      )
    } catch {
      this.handleFailure(socket)
    }
  }

  private handleMessage(socket: CoinbaseSocket, data: unknown): void {
    if (!this.started || this.socket !== socket) return
    if (typeof data !== 'string') {
      this.report({
        code: 'invalid_message',
        message: 'Coinbase message must be JSON text.',
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
        message: 'Coinbase message is not valid JSON.',
      })
      this.handleFailure(socket)
      return
    }
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.reject('invalid_message', 'Coinbase message must contain a type.')
      this.handleFailure(socket)
      return
    }
    if (
      raw.type === 'subscriptions' ||
      !['ticker', 'heartbeat'].includes(raw.type)
    ) {
      return
    }

    const parsed =
      raw.type === 'ticker' ? parseTicker(raw) : parseHeartbeat(raw)
    if (!parsed.valid) {
      this.reject(
        'invalid_payload',
        'Coinbase payload failed validation.',
        parsed.issues,
      )
      this.handleFailure(socket)
      return
    }
    if (parsed.value.payload.type === 'ticker') {
      this.handleTicker(parsed.value.payload, parsed.value.eventTime)
    } else {
      this.handleHeartbeat(parsed.value.payload, parsed.value.eventTime)
    }
  }

  private handleTicker(
    payload: NormalizedMarketPayload & { type: 'ticker' },
    eventTime: TimestampMs,
  ): void {
    if (
      this.tickerSequence !== undefined &&
      payload.sequence <= this.tickerSequence
    ) {
      this.reject(
        'sequence_out_of_order',
        'Ticker sequence is duplicate or out of order.',
      )
      return
    }
    const cursor = this.store.getCursor(SOURCE, INSTRUMENT)
    const previousTradeId = cursor?.lastTradeId
    if (previousTradeId !== undefined && payload.tradeId <= previousTradeId) {
      this.reject(
        'trade_out_of_order',
        'Ticker trade id is duplicate or out of order.',
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
      this.store.recordGap({
        source: SOURCE,
        instrumentId: INSTRUMENT,
        prevSequence: previousTradeId,
        currentSequence: payload.tradeId,
        detectedAt: envelope.receivedTime,
        evidence: {
          kind: 'trade_id',
          channel: 'ticker',
          connectionRevision: this.connectionRevision,
        },
      })
    }
    this.tickerSequence = payload.sequence
    this.updateCursor(envelope, payload.sequence, payload.tradeId)
    this.scheduleStale(envelope)
  }

  private handleHeartbeat(
    payload: NormalizedMarketPayload & { type: 'heartbeat' },
    eventTime: TimestampMs,
  ): void {
    if (
      this.heartbeatSequence !== undefined &&
      payload.sequence <= this.heartbeatSequence
    ) {
      this.reject(
        'sequence_out_of_order',
        'Heartbeat sequence is duplicate or out of order.',
      )
      return
    }
    const cursor = this.store.getCursor(SOURCE, INSTRUMENT)
    const previousTradeId = cursor?.lastTradeId
    const envelope = this.envelope(payload, eventTime)
    if (envelope === null) return
    const result = this.persist(envelope)
    if (result === null) return
    if (
      previousTradeId !== undefined &&
      payload.lastTradeId > previousTradeId + 1
    ) {
      this.store.recordGap({
        source: SOURCE,
        instrumentId: INSTRUMENT,
        prevSequence: previousTradeId,
        currentSequence: payload.lastTradeId,
        detectedAt: envelope.receivedTime,
        evidence: {
          kind: 'trade_id',
          channel: 'heartbeat',
          connectionRevision: this.connectionRevision,
        },
      })
    }
    this.heartbeatSequence = payload.sequence
    this.updateCursor(envelope, payload.sequence, payload.lastTradeId)
    this.scheduleStale(envelope)
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
        'Coinbase event time failed freshness validation.',
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

  private handleFailure(socket: CoinbaseSocket | null): void {
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

  private detach(socket: CoinbaseSocket): void {
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

  private reject(
    code: string,
    message: string,
    issues?: readonly ValidationIssue[],
  ): void {
    this.report({ code, message, ...(issues === undefined ? {} : { issues }) })
  }

  private report(rejection: CoinbaseRejection): void {
    this.onRejected?.(rejection)
  }
}

function parseTicker(input: Record<string, unknown>): ValidationResult<{
  payload: NormalizedMarketPayload
  eventTime: TimestampMs
}> {
  const eventTime = parseCoinbaseTime(input.time, 'time')
  const sequence = parseSequence(input.sequence, 'sequence')
  const tradeId = parseSequence(input.trade_id, 'trade_id')
  const productId = input.product_id === 'BTC-EUR'
  const price = parsePositiveNumber(input.price, 'price')
  const issues = [
    ...(!eventTime.valid ? eventTime.issues : []),
    ...(!sequence.valid ? sequence.issues : []),
    ...(!tradeId.valid ? tradeId.issues : []),
    ...(!productId
      ? [
          issue(
            'unsupported_instrument',
            'product_id',
            'Only BTC-EUR is supported.',
          ),
        ]
      : []),
    ...(!price.valid ? price.issues : []),
  ]
  if (
    issues.length > 0 ||
    !eventTime.valid ||
    !sequence.valid ||
    !tradeId.valid ||
    !price.valid
  ) {
    return invalid(issues)
  }
  const validation = validateNormalizedMarketPayload({
    type: 'ticker',
    productId: 'BTC-EUR',
    tradeId: tradeId.value,
    sequence: sequence.value,
    price: price.value,
  })
  return validation.valid
    ? valid({ payload: validation.value, eventTime: eventTime.value })
    : invalid(validation.issues)
}

function parseHeartbeat(input: Record<string, unknown>): ValidationResult<{
  payload: NormalizedMarketPayload
  eventTime: TimestampMs
}> {
  const eventTime = parseCoinbaseTime(input.time, 'time')
  const sequence = parseSequence(input.sequence, 'sequence')
  const lastTradeId = parseSequence(input.last_trade_id, 'last_trade_id')
  const productId = input.product_id === 'BTC-EUR'
  const issues = [
    ...(!eventTime.valid ? eventTime.issues : []),
    ...(!sequence.valid ? sequence.issues : []),
    ...(!lastTradeId.valid ? lastTradeId.issues : []),
    ...(!productId
      ? [
          issue(
            'unsupported_instrument',
            'product_id',
            'Only BTC-EUR is supported.',
          ),
        ]
      : []),
  ]
  if (
    issues.length > 0 ||
    !eventTime.valid ||
    !sequence.valid ||
    !lastTradeId.valid
  ) {
    return invalid(issues)
  }
  const validation = validateNormalizedMarketPayload({
    type: 'heartbeat',
    productId: 'BTC-EUR',
    sequence: sequence.value,
    lastTradeId: lastTradeId.value,
  })
  return validation.valid
    ? valid({ payload: validation.value, eventTime: eventTime.value })
    : invalid(validation.issues)
}

function parseCoinbaseTime(
  value: unknown,
  path: string,
): ValidationResult<TimestampMs> {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(timestamp) && timestamp >= 0
    ? { valid: true as const, value: timestamp as TimestampMs }
    : invalid([
        issue(
          'invalid_timestamp',
          path,
          'Coinbase event time must be a valid ISO timestamp.',
        ),
      ])
}

function parseSequence(value: unknown, path: string): ValidationResult<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { valid: true as const, value: value as number }
    : invalid([
        issue(
          'invalid_sequence',
          path,
          'Sequence values must be non-negative safe integers.',
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
        issue('invalid_price', path, 'Price must be finite and positive.'),
      ])
}
