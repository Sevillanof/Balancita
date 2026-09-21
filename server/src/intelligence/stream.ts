import type { MarketDataStatus, TimestampMs } from './contracts.ts'
import {
  calculateStaleRate,
  summarizeGapTransitions,
  summarizePercentiles,
} from './slis.ts'
import type {
  MarketStore,
  StoredMarketObservation,
} from './market/market-store.ts'

export const INTELLIGENCE_STREAM_VERSION = 'intelligence-stream.v1'
export const INTELLIGENCE_SNAPSHOT_VERSION = 'intelligence-snapshot.v1'
export const INTELLIGENCE_EVENT_NAME = 'intelligence.snapshot'

export type CollectorConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stale'
  | 'stopped'
  | 'unavailable'

export type IntelligencePipelineStatus =
  'disabled' | 'unavailable' | 'connecting' | 'ready' | 'stale' | 'gap'

export interface IntelligenceCollectorObserver {
  getStatus?: () => CollectorConnectionStatus
  subscribe?: (listener: () => void) => () => void
}

export interface IntelligenceMarketSnapshot {
  readonly source: string
  readonly instrumentId: 'BTC-EUR'
  readonly status: MarketDataStatus
  readonly price: number
  readonly eventTime: TimestampMs
  readonly receivedTime: TimestampMs
  readonly displayTime: TimestampMs
  readonly freshness: {
    readonly ageMs: number
    readonly isStale: boolean
    readonly clockInverted: boolean
  }
  readonly sequence?: number
}

export interface IntelligenceObservability {
  readonly windowSize: number
  readonly latencyMs: {
    readonly count: number
    readonly p50: number | null
    readonly p95: number | null
  }
  readonly stale: {
    readonly staleCount: number
    readonly totalCount: number
    readonly rate: number | null
  }
  readonly gaps: {
    readonly gapCount: number
    readonly expectedOpportunities: number
    readonly rate: number | null
    readonly sequenceAvailable: boolean
  }
}

export interface IntelligenceUnavailableSummary {
  readonly status: 'unavailable'
  readonly reason: string
}

export interface IntelligenceAnalysisSummary {
  readonly status: 'unavailable'
  readonly reason: 'not_persisted'
}

export interface IntelligenceForecastSummary {
  readonly status: 'available'
  readonly id: string
  readonly version: string
  readonly horizon: string
  readonly createdAt: TimestampMs
  readonly abstained: boolean
  readonly probabilityUp: number
  readonly probabilityDown: number
  readonly probabilityFlat: number
}

export interface IntelligenceNewsSummary {
  readonly status: 'available'
  readonly totalCount: number
  readonly relevantCount: number
  readonly latestPublishedAt: TimestampMs
}

export interface IntelligenceStreamSnapshot {
  readonly version: typeof INTELLIGENCE_SNAPSHOT_VERSION
  readonly instrumentId: 'BTC-EUR'
  readonly generatedAt: TimestampMs
  readonly pipeline: {
    readonly status: IntelligencePipelineStatus
    readonly collectorEnabled: boolean
    readonly connection: CollectorConnectionStatus | 'disabled'
    readonly message: string
  }
  readonly market: IntelligenceMarketSnapshot | null
  readonly observability: IntelligenceObservability | null
  readonly summaries: {
    readonly analysis: IntelligenceAnalysisSummary
    readonly forecast:
      IntelligenceForecastSummary | IntelligenceUnavailableSummary
    readonly news: IntelligenceNewsSummary | IntelligenceUnavailableSummary
  }
}

export interface IntelligenceStreamEvent {
  readonly version: typeof INTELLIGENCE_STREAM_VERSION
  readonly type: 'snapshot'
  readonly id: string
  readonly serverTime: TimestampMs
  readonly snapshot: IntelligenceStreamSnapshot
}

export interface IntelligenceSnapshotOptions {
  readonly collectorEnabled: boolean
  readonly marketStore?: MarketStore
  readonly collector?: IntelligenceCollectorObserver
  readonly staleAfterMs: number
  readonly clock: () => number
  readonly windowSize?: number
}

export function createIntelligenceSnapshot(
  options: IntelligenceSnapshotOptions,
): IntelligenceStreamSnapshot {
  const generatedAt = options.clock() as TimestampMs
  const collectorStatus = options.collector?.getStatus?.() ?? 'unavailable'
  const observations = (options.marketStore?.listObservations() ?? []).slice(
    -(options.windowSize ?? 200),
  )
  const cursor = options.marketStore?.getCursor('coinbase_exchange', 'BTC-EUR')
  const latest = [...observations]
    .filter((observation) => observation.payload.type === 'ticker')
    .sort((left, right) => left.displayTime - right.displayTime)
    .at(-1)
  const gapCount = options.marketStore?.listGaps().length ?? 0
  const latency = summarizePercentiles(
    observations.map((observation) =>
      Math.max(0, observation.receivedTime - observation.eventTime),
    ),
  )
  const stale = calculateStaleRate(
    observations.map(
      (observation) =>
        observation.freshnessIsStale ||
        observation.freshnessAgeMs > options.staleAfterMs,
    ),
  )
  const gaps = summarizeGapTransitions({
    gapCount,
    observedMessages: observations.length,
    sequenceAvailable: observations.some(
      (observation) => observation.sequence !== undefined,
    ),
  })

  const observability =
    options.marketStore === undefined ||
    latency.valid === false ||
    stale.valid === false ||
    gaps.valid === false
      ? null
      : {
          windowSize: observations.length,
          latencyMs: latency.value,
          stale: stale.value,
          gaps: gaps.value,
        }

  const market =
    latest === undefined
      ? null
      : marketSnapshot(latest, cursor, options.staleAfterMs)
  const pipeline = pipelineSnapshot({
    collectorEnabled: options.collectorEnabled,
    collectorStatus,
    hasStore: options.marketStore !== undefined,
    cursorStatus: cursor?.status,
    gapRate: observability?.gaps.rate ?? null,
    hasMarket: market !== null,
  })

  const forecasts = options.marketStore?.listForecasts({
    instrumentId: 'BTC-EUR',
  })
  const latestForecast = forecasts?.at(-1)
  const news = options.marketStore?.listNewsEvidence({ usableOnly: true }) ?? []
  const latestPublishedAt = news.reduce<number | null>(
    (latestTime, item) =>
      latestTime === null
        ? item.publishedAt
        : Math.max(latestTime, item.publishedAt),
    null,
  )

  return {
    version: INTELLIGENCE_SNAPSHOT_VERSION,
    instrumentId: 'BTC-EUR',
    generatedAt,
    pipeline,
    market,
    observability,
    summaries: {
      analysis: { status: 'unavailable', reason: 'not_persisted' },
      forecast:
        latestForecast === undefined
          ? { status: 'unavailable', reason: 'no_forecast' }
          : {
              status: 'available',
              id: latestForecast.id,
              version: latestForecast.version,
              horizon: latestForecast.horizon,
              createdAt: latestForecast.createdAt,
              abstained: latestForecast.abstained,
              probabilityUp: latestForecast.probabilityUp,
              probabilityDown: latestForecast.probabilityDown,
              probabilityFlat: latestForecast.probabilityFlat,
            },
      news:
        latestPublishedAt === null
          ? { status: 'unavailable', reason: 'no_news' }
          : {
              status: 'available',
              totalCount: news.length,
              relevantCount: news.filter(
                (item) => item.relevance === 'relevant',
              ).length,
              latestPublishedAt: latestPublishedAt as TimestampMs,
            },
    },
  }
}

function marketSnapshot(
  observation: StoredMarketObservation,
  cursor:
    | {
        readonly status: MarketDataStatus
        readonly freshnessAgeMs?: number
      }
    | null
    | undefined,
  staleAfterMs: number,
): IntelligenceMarketSnapshot {
  if (observation.payload.type !== 'ticker') {
    throw new Error('Market snapshot requires a ticker observation.')
  }
  const isStale =
    cursor?.status === 'stale' ||
    observation.freshnessIsStale ||
    observation.freshnessAgeMs > staleAfterMs
  return {
    source: observation.source,
    instrumentId: observation.instrumentId,
    status: isStale ? 'stale' : (cursor?.status ?? observation.status),
    price: observation.payload.price,
    eventTime: observation.eventTime,
    receivedTime: observation.receivedTime,
    displayTime: observation.displayTime,
    freshness: {
      ageMs: cursor?.freshnessAgeMs ?? observation.freshnessAgeMs,
      isStale,
      clockInverted: false,
    },
    ...(observation.sequence === undefined
      ? {}
      : { sequence: observation.sequence }),
  }
}

function pipelineSnapshot(input: {
  readonly collectorEnabled: boolean
  readonly collectorStatus: CollectorConnectionStatus
  readonly hasStore: boolean
  readonly cursorStatus?: MarketDataStatus
  readonly gapRate: number | null
  readonly hasMarket: boolean
}): IntelligenceStreamSnapshot['pipeline'] {
  if (!input.collectorEnabled)
    return {
      status: 'disabled',
      collectorEnabled: false,
      connection: 'disabled',
      message: 'Market collector is disabled.',
    }
  if (!input.hasStore)
    return {
      status: 'unavailable',
      collectorEnabled: true,
      connection: 'unavailable',
      message: 'Market store is unavailable.',
    }
  if (
    input.collectorStatus === 'connecting' ||
    input.collectorStatus === 'reconnecting'
  )
    return {
      status: 'connecting',
      collectorEnabled: true,
      connection: input.collectorStatus,
      message: 'Market collector is connecting.',
    }
  if (!input.hasMarket || input.collectorStatus === 'unavailable')
    return {
      status: 'unavailable',
      collectorEnabled: true,
      connection: input.collectorStatus,
      message: 'No market snapshot is available yet.',
    }
  if (input.cursorStatus === 'stale' || input.collectorStatus === 'stale')
    return {
      status: 'stale',
      collectorEnabled: true,
      connection: input.collectorStatus,
      message: 'The latest market snapshot is stale.',
    }
  if (input.gapRate !== null && input.gapRate > 0)
    return {
      status: 'gap',
      collectorEnabled: true,
      connection: input.collectorStatus,
      message: 'A sequence gap was detected in the observation window.',
    }
  return {
    status: 'ready',
    collectorEnabled: true,
    connection: input.collectorStatus,
    message: 'Market intelligence pipeline is ready.',
  }
}

export function parseIntelligenceStreamEvent(
  input: unknown,
): IntelligenceStreamEvent {
  if (!isRecord(input) || input.version !== INTELLIGENCE_STREAM_VERSION)
    throw new Error('Invalid intelligence stream event: version.')
  if (input.type !== 'snapshot' || typeof input.id !== 'string')
    throw new Error('Invalid intelligence stream event: envelope.')
  if (!isTimestamp(input.serverTime) || !isSnapshot(input.snapshot))
    throw new Error('Invalid intelligence stream event: payload.')
  return input as unknown as IntelligenceStreamEvent
}

export interface SseSink {
  write: (chunk: string) => boolean
  close?: () => void
}

interface Client {
  readonly sink: SseSink
  readonly timer: ReturnType<typeof setTimeout>
}

export class IntelligenceStreamHub {
  private readonly snapshot: () => IntelligenceStreamSnapshot
  private readonly maxClients: number
  private readonly keepAliveMs: number
  private readonly clock: () => number
  private readonly clients = new Map<number, Client>()
  private nextClientId = 1
  private nextEventId = 1

  constructor(options: {
    readonly snapshot: () => IntelligenceStreamSnapshot
    readonly maxClients: number
    readonly keepAliveMs: number
    readonly clock: () => number
  }) {
    this.snapshot = options.snapshot
    this.maxClients = options.maxClients
    this.keepAliveMs = options.keepAliveMs
    this.clock = options.clock
  }

  connect(sink: SseSink, lastEventId?: string): () => void {
    // Snapshots are replaceable state; reconnects always receive a fresh one.
    void lastEventId
    if (this.clients.size >= this.maxClients)
      throw new Error('SSE client limit reached')

    const clientId = this.nextClientId++
    const cleanup = () => {
      const client = this.clients.get(clientId)
      if (client === undefined) return
      clearTimeout(client.timer)
      this.clients.delete(clientId)
      client.sink.close?.()
    }
    const write = (chunk: string): boolean => {
      try {
        return sink.write(chunk)
      } catch {
        cleanup()
        return false
      }
    }
    const initial = serializeEvent(this.event(this.snapshot()))
    if (!write(initial)) return () => undefined
    const timer = setTimeout(() => this.keepAlive(clientId), this.keepAliveMs)
    this.clients.set(clientId, { sink, timer })
    return cleanup
  }

  publish(): void {
    const chunk = serializeEvent(this.event(this.snapshot()))
    for (const [clientId, client] of this.clients) {
      try {
        if (!client.sink.write(chunk)) this.remove(clientId)
      } catch {
        this.remove(clientId)
      }
    }
  }

  clientCount(): number {
    return this.clients.size
  }

  close(): void {
    for (const clientId of this.clients.keys()) this.remove(clientId)
  }

  private keepAlive(clientId: number): void {
    const client = this.clients.get(clientId)
    if (client === undefined) return
    try {
      if (!client.sink.write(': keepalive\n\n')) {
        this.remove(clientId)
        return
      }
    } catch {
      this.remove(clientId)
      return
    }
    const timer = setTimeout(() => this.keepAlive(clientId), this.keepAliveMs)
    this.clients.set(clientId, { sink: client.sink, timer })
  }

  private remove(clientId: number): void {
    const client = this.clients.get(clientId)
    if (client === undefined) return
    clearTimeout(client.timer)
    this.clients.delete(clientId)
    client.sink.close?.()
  }

  private event(snapshot: IntelligenceStreamSnapshot): IntelligenceStreamEvent {
    return parseIntelligenceStreamEvent({
      version: INTELLIGENCE_STREAM_VERSION,
      type: 'snapshot',
      id: String(this.nextEventId++),
      serverTime: this.clock() as TimestampMs,
      snapshot,
    })
  }
}

function serializeEvent(event: IntelligenceStreamEvent): string {
  return [
    `id: ${event.id}`,
    `event: ${INTELLIGENCE_EVENT_NAME}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n')
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function isTimestamp(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
}

function isSnapshot(input: unknown): input is IntelligenceStreamSnapshot {
  if (!isRecord(input)) return false
  if (
    input.version !== INTELLIGENCE_SNAPSHOT_VERSION ||
    input.instrumentId !== 'BTC-EUR' ||
    !isTimestamp(input.generatedAt) ||
    !isPipeline(input.pipeline) ||
    !isObservability(input.observability) ||
    !isRecord(input.summaries)
  )
    return false
  return (
    isAnalysisSummary(input.summaries.analysis) &&
    isForecastSummary(input.summaries.forecast) &&
    isNewsSummary(input.summaries.news) &&
    (input.market === null || isMarket(input.market))
  )
}

function isPipeline(input: unknown): boolean {
  if (!isRecord(input)) return false
  return (
    ['disabled', 'unavailable', 'connecting', 'ready', 'stale', 'gap'].includes(
      input.status as string,
    ) &&
    typeof input.collectorEnabled === 'boolean' &&
    [
      'disabled',
      'connecting',
      'connected',
      'reconnecting',
      'stale',
      'stopped',
      'unavailable',
    ].includes(input.connection as string) &&
    typeof input.message === 'string'
  )
}

function isObservability(input: unknown): boolean {
  if (input === null) return true
  if (!isRecord(input) || !isNonNegativeInteger(input.windowSize)) return false
  if (
    !isPercentiles(input.latencyMs) ||
    !isRate(input.stale) ||
    !isGap(input.gaps)
  )
    return false
  return true
}

function isPercentiles(input: unknown): boolean {
  if (!isRecord(input) || !isNonNegativeInteger(input.count)) return false
  return isNullableNonNegative(input.p50) && isNullableNonNegative(input.p95)
}

function isRate(input: unknown): boolean {
  if (!isRecord(input)) return false
  return (
    isNonNegativeInteger(input.staleCount) &&
    isNonNegativeInteger(input.totalCount) &&
    isNullableRate(input.rate)
  )
}

function isGap(input: unknown): boolean {
  if (!isRecord(input)) return false
  return (
    isNonNegativeInteger(input.gapCount) &&
    isNonNegativeInteger(input.expectedOpportunities) &&
    isNullableRate(input.rate) &&
    typeof input.sequenceAvailable === 'boolean'
  )
}

function isMarket(input: unknown): boolean {
  if (!isRecord(input)) return false
  return (
    typeof input.source === 'string' &&
    input.instrumentId === 'BTC-EUR' &&
    ['live', 'stale', 'invalid', 'gap'].includes(input.status as string) &&
    typeof input.price === 'number' &&
    Number.isFinite(input.price) &&
    isTimestamp(input.eventTime) &&
    isTimestamp(input.receivedTime) &&
    isTimestamp(input.displayTime) &&
    isRecord(input.freshness) &&
    isNonNegativeNumber(input.freshness.ageMs) &&
    typeof input.freshness.isStale === 'boolean' &&
    typeof input.freshness.clockInverted === 'boolean'
  )
}

function isAnalysisSummary(input: unknown): boolean {
  return (
    isRecord(input) &&
    input.status === 'unavailable' &&
    typeof input.reason === 'string'
  )
}

function isForecastSummary(input: unknown): boolean {
  if (!isRecord(input)) return false
  if (input.status === 'unavailable') return typeof input.reason === 'string'
  return (
    input.status === 'available' &&
    typeof input.id === 'string' &&
    typeof input.version === 'string' &&
    typeof input.horizon === 'string' &&
    isTimestamp(input.createdAt) &&
    typeof input.abstained === 'boolean' &&
    isProbability(input.probabilityUp) &&
    isProbability(input.probabilityDown) &&
    isProbability(input.probabilityFlat)
  )
}

function isNewsSummary(input: unknown): boolean {
  if (!isRecord(input)) return false
  if (input.status === 'unavailable') return typeof input.reason === 'string'
  return (
    input.status === 'available' &&
    isNonNegativeInteger(input.totalCount) &&
    isNonNegativeInteger(input.relevantCount) &&
    input.relevantCount <= input.totalCount &&
    isTimestamp(input.latestPublishedAt)
  )
}

function isProbability(input: unknown): input is number {
  return (
    typeof input === 'number' &&
    Number.isFinite(input) &&
    input >= 0 &&
    input <= 1
  )
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
}

function isNonNegativeNumber(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0
}

function isNullableNonNegative(input: unknown): input is number | null {
  return input === null || isNonNegativeNumber(input)
}

function isNullableRate(input: unknown): input is number | null {
  return input === null || (isNonNegativeNumber(input) && input <= 1)
}
