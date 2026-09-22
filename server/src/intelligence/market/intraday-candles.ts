import type {
  GapMetrics,
  MarketDataStatus,
  SupportedInstrumentId,
  TimestampMs,
} from '../contracts.ts'

export type CandleInterval = '1m' | '5m' | '15m' | '1h'

export const INTERVAL_MS: Readonly<Record<CandleInterval, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
}

export interface IntradayCandle {
  readonly interval: CandleInterval
  readonly bucketStart: TimestampMs
  readonly bucketEnd: TimestampMs
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly eventTimeStart: TimestampMs
  readonly eventTimeEnd: TimestampMs
  readonly receivedTimeStart: TimestampMs
  readonly receivedTimeEnd: TimestampMs
  readonly displayTimeStart: TimestampMs
  readonly displayTimeEnd: TimestampMs
  readonly freshnessAgeMs: number
  readonly freshnessIsStale: boolean
  readonly freshnessClockInverted: boolean
  readonly status: MarketDataStatus
  readonly source: string
  readonly instrumentId: SupportedInstrumentId
  readonly observationCount: number
  readonly isClosed: boolean
}

export interface CandleBuildRejection {
  readonly index: number
  readonly code:
    | 'invalid_observation'
    | 'invalid_timestamp'
    | 'future_observation'
    | 'unsupported_payload'
  readonly message: string
}

export interface CandleBuildInput {
  readonly interval: CandleInterval
  readonly asOfTimestamp: TimestampMs
  readonly observations: readonly unknown[]
  readonly gapMetrics?: GapMetrics
}

export interface IntradayCandleBuildResult {
  readonly interval: CandleInterval
  readonly asOfTimestamp: TimestampMs
  readonly all: readonly IntradayCandle[]
  readonly closed: readonly IntradayCandle[]
  readonly provisional: IntradayCandle | null
  readonly rejected: readonly CandleBuildRejection[]
  readonly duplicateCount: number
  readonly outOfOrderCount: number
  readonly gapMetrics: GapMetrics
}

interface CandlePayload {
  readonly type: 'ticker' | 'trade'
  readonly productId: 'BTC-EUR'
  readonly tradeId: number
  readonly sequence: number
  readonly price: number
  readonly size?: number
}

interface ValidObservation {
  readonly source: string
  readonly instrumentId: SupportedInstrumentId
  readonly eventTime: TimestampMs
  readonly receivedTime: TimestampMs
  readonly displayTime: TimestampMs
  readonly sequence?: number
  readonly status: MarketDataStatus
  readonly payload: CandlePayload
  readonly freshnessAgeMs: number
  readonly freshnessIsStale: boolean
  readonly freshnessClockInverted: boolean
  readonly identity: string
}

interface ObservationRecord {
  readonly source: string
  readonly instrumentId: SupportedInstrumentId
  readonly eventTime: TimestampMs
  readonly receivedTime: TimestampMs
  readonly displayTime: TimestampMs
  readonly sequence?: number
  readonly status: MarketDataStatus
  readonly payload: CandlePayload
  readonly freshnessAgeMs: number
  readonly freshnessIsStale: boolean
  readonly freshnessClockInverted: boolean
  readonly contentHash?: string
  readonly id?: string
}

export function buildIntradayCandles(
  input: CandleBuildInput,
): IntradayCandleBuildResult {
  const intervalMs = INTERVAL_MS[input.interval]
  if (intervalMs === undefined) {
    throw new Error(`Unsupported candle interval: ${String(input.interval)}`)
  }
  if (!validTimestamp(input.asOfTimestamp)) {
    throw new Error('Candle cutoff must be a non-negative epoch millisecond.')
  }

  const rejected: CandleBuildRejection[] = []
  const validObservations: ValidObservation[] = []
  const identities = new Set<string>()
  let duplicateCount = 0
  let outOfOrderCount = 0
  let previousEventTime: number | undefined

  input.observations.forEach((candidate, index) => {
    const parsed = parseObservation(candidate)
    if (!parsed.valid) {
      rejected.push({ index, code: parsed.code, message: parsed.message })
      return
    }
    if (
      previousEventTime !== undefined &&
      parsed.value.eventTime < previousEventTime
    ) {
      outOfOrderCount += 1
    }
    previousEventTime = parsed.value.eventTime
    if (parsed.value.eventTime > input.asOfTimestamp) {
      rejected.push({
        index,
        code: 'future_observation',
        message: 'Observation is after the explicit evidence cutoff.',
      })
      return
    }
    if (identities.has(parsed.value.identity)) {
      duplicateCount += 1
      return
    }
    identities.add(parsed.value.identity)
    validObservations.push(parsed.value)
  })

  validObservations.sort(compareObservations)
  const buckets = new Map<number, ValidObservation[]>()
  for (const current of validObservations) {
    const bucketStart = Math.floor(current.eventTime / intervalMs) * intervalMs
    const bucket = buckets.get(bucketStart)
    if (bucket === undefined) buckets.set(bucketStart, [current])
    else bucket.push(current)
  }

  const all = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucketStart, bucket]) =>
      aggregateBucket(
        input.interval,
        bucketStart as TimestampMs,
        intervalMs,
        input.asOfTimestamp,
        bucket,
      ),
    )
  const closed = all.filter((item) => item.isClosed)
  const provisional =
    all.find(
      (item) =>
        !item.isClosed &&
        item.bucketStart <= input.asOfTimestamp &&
        input.asOfTimestamp < item.bucketEnd,
    ) ?? null

  return {
    interval: input.interval,
    asOfTimestamp: input.asOfTimestamp,
    all,
    closed,
    provisional,
    rejected,
    duplicateCount,
    outOfOrderCount,
    gapMetrics:
      input.gapMetrics ?? defaultGapMetrics(validObservations.length > 0),
  }
}

function aggregateBucket(
  interval: CandleInterval,
  bucketStart: TimestampMs,
  intervalMs: number,
  asOfTimestamp: TimestampMs,
  observations: readonly ValidObservation[],
): IntradayCandle {
  const first = observations[0]
  if (first === undefined) throw new Error('Cannot aggregate an empty bucket.')
  const prices = observations.map((item) => item.payload.price)
  const eventTimes = observations.map((item) => item.eventTime)
  const receivedTimes = observations.map((item) => item.receivedTime)
  const displayTimes = observations.map((item) => item.displayTime)
  const bucketEnd = (bucketStart + intervalMs) as TimestampMs
  return {
    interval,
    bucketStart,
    bucketEnd,
    open: first.payload.price,
    high: Math.max(...prices),
    low: Math.min(...prices),
    close:
      observations[observations.length - 1]?.payload.price ??
      first.payload.price,
    volume: observations.reduce(
      (total, item) => total + (item.payload.size ?? 0),
      0,
    ),
    eventTimeStart: Math.min(...eventTimes) as TimestampMs,
    eventTimeEnd: Math.max(...eventTimes) as TimestampMs,
    receivedTimeStart: Math.min(...receivedTimes) as TimestampMs,
    receivedTimeEnd: Math.max(...receivedTimes) as TimestampMs,
    displayTimeStart: Math.min(...displayTimes) as TimestampMs,
    displayTimeEnd: Math.max(...displayTimes) as TimestampMs,
    freshnessAgeMs: Math.max(
      ...observations.map((item) => item.freshnessAgeMs),
    ),
    freshnessIsStale: observations.some((item) => item.freshnessIsStale),
    freshnessClockInverted: observations.some(
      (item) => item.freshnessClockInverted,
    ),
    status: aggregateStatus(observations),
    source: first.source,
    instrumentId: first.instrumentId,
    observationCount: observations.length,
    isClosed: bucketEnd <= asOfTimestamp,
  }
}

function aggregateStatus(
  observations: readonly ValidObservation[],
): MarketDataStatus {
  if (observations.some((item) => item.status === 'invalid')) return 'invalid'
  if (observations.some((item) => item.status === 'gap')) return 'gap'
  if (observations.some((item) => item.status === 'stale')) return 'stale'
  return 'live'
}

function parseObservation(candidate: unknown):
  | { readonly valid: true; readonly value: ValidObservation }
  | {
      readonly valid: false
      readonly code: CandleBuildRejection['code']
      readonly message: string
    } {
  if (!isRecord(candidate))
    return rejection('invalid_observation', 'Observation must be an object.')
  const timestamps = [
    ['eventTime', candidate.eventTime],
    ['receivedTime', candidate.receivedTime],
    ['displayTime', candidate.displayTime],
  ] as const
  for (const [name, timestamp] of timestamps) {
    if (!validTimestamp(timestamp))
      return rejection(
        'invalid_timestamp',
        `${name} must be a non-negative epoch millisecond.`,
      )
  }
  if (
    (candidate.receivedTime as number) < (candidate.eventTime as number) ||
    (candidate.displayTime as number) < (candidate.receivedTime as number)
  )
    return rejection(
      'invalid_timestamp',
      'Observation timestamps must be ordered event <= received <= display.',
    )
  if (
    typeof candidate.source !== 'string' ||
    candidate.source.length === 0 ||
    candidate.instrumentId !== 'BTC-EUR' ||
    !validStatus(candidate.status) ||
    typeof candidate.freshnessAgeMs !== 'number' ||
    !Number.isFinite(candidate.freshnessAgeMs) ||
    candidate.freshnessAgeMs < 0 ||
    typeof candidate.freshnessIsStale !== 'boolean'
  )
    return rejection('invalid_observation', 'Observation metadata is invalid.')
  if (!isRecord(candidate.payload))
    return rejection(
      'unsupported_payload',
      'Only ticker and trade payloads contribute to intraday candles.',
    )
  const payloadType = candidate.payload.type
  if (payloadType !== 'ticker' && payloadType !== 'trade')
    return rejection(
      'unsupported_payload',
      'Only ticker and trade payloads contribute to intraday candles.',
    )
  if (
    candidate.payload.productId !== 'BTC-EUR' ||
    !safeInteger(candidate.payload.tradeId) ||
    !safeInteger(candidate.payload.sequence) ||
    !positiveFinite(candidate.payload.price)
  )
    return rejection('unsupported_payload', 'Payload values are invalid.')

  let size: number | undefined
  if (payloadType === 'ticker') {
    if (
      candidate.payload.size !== undefined &&
      !positiveFinite(candidate.payload.size)
    )
      return rejection(
        'unsupported_payload',
        'Ticker payload values are invalid.',
      )
    if (candidate.payload.size !== undefined) size = candidate.payload.size
  } else {
    if (
      !positiveFinite(candidate.payload.qty) ||
      !validTradeSide(candidate.payload.side)
    )
      return rejection(
        'unsupported_payload',
        'Trade payload values are invalid.',
      )
    size = candidate.payload.qty
  }

  const payload: CandlePayload = {
    type: payloadType,
    productId: 'BTC-EUR',
    tradeId: candidate.payload.tradeId,
    sequence: candidate.payload.sequence,
    price: candidate.payload.price,
    ...(size === undefined ? {} : { size }),
  }
  const record: ObservationRecord = {
    source: candidate.source,
    instrumentId: 'BTC-EUR',
    eventTime: candidate.eventTime as TimestampMs,
    receivedTime: candidate.receivedTime as TimestampMs,
    displayTime: candidate.displayTime as TimestampMs,
    sequence: safeInteger(candidate.sequence)
      ? candidate.sequence
      : payload.sequence,
    status: candidate.status,
    payload,
    freshnessAgeMs: candidate.freshnessAgeMs,
    freshnessIsStale: candidate.freshnessIsStale,
    freshnessClockInverted:
      typeof candidate.freshnessClockInverted === 'boolean'
        ? candidate.freshnessClockInverted
        : false,
    ...(typeof candidate.contentHash === 'string'
      ? { contentHash: candidate.contentHash }
      : {}),
    ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
  }
  const identity =
    record.contentHash ??
    JSON.stringify({
      source: record.source,
      instrumentId: record.instrumentId,
      eventTime: record.eventTime,
      sequence: record.sequence ?? null,
      tradeId: record.payload.tradeId,
      price: record.payload.price,
      size: record.payload.size ?? null,
    })
  return {
    valid: true,
    value: { ...record, identity },
  }
}

function compareObservations(
  left: ValidObservation,
  right: ValidObservation,
): number {
  if (left.eventTime !== right.eventTime)
    return left.eventTime - right.eventTime
  if (
    (left.sequence ?? Number.MAX_SAFE_INTEGER) !==
    (right.sequence ?? Number.MAX_SAFE_INTEGER)
  )
    return (
      (left.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.sequence ?? Number.MAX_SAFE_INTEGER)
    )
  if (left.payload.tradeId !== right.payload.tradeId)
    return left.payload.tradeId - right.payload.tradeId
  return left.identity.localeCompare(right.identity)
}

function defaultGapMetrics(sequenceAvailable: boolean): GapMetrics {
  return {
    gapCount: 0,
    expectedOpportunities: 0,
    rate: null,
    sequenceAvailable,
  }
}

function rejection(
  code: CandleBuildRejection['code'],
  message: string,
): {
  readonly valid: false
  readonly code: CandleBuildRejection['code']
  readonly message: string
} {
  return { valid: false, code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validTimestamp(value: unknown): value is TimestampMs {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function validStatus(value: unknown): value is MarketDataStatus {
  return (
    value === 'live' ||
    value === 'stale' ||
    value === 'invalid' ||
    value === 'gap'
  )
}

function validTradeSide(value: unknown): boolean {
  return value === 'buy' || value === 'sell'
}
