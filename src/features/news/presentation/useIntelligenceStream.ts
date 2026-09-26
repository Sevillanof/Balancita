import { useEffect, useState } from 'react'

export type IntelligenceStreamStatus =
  'loading' | 'ready' | 'stale' | 'error' | 'disabled'
export type IntelligenceStreamTransportStatus =
  'connecting' | 'connected' | 'reconnecting' | 'disabled'

export interface IntelligenceStreamSnapshot {
  readonly version: 'intelligence-snapshot.v1'
  readonly instrumentId: 'BTC-EUR'
  readonly generatedAt: number
  readonly pipeline: {
    readonly status:
      'disabled' | 'unavailable' | 'connecting' | 'ready' | 'stale' | 'gap'
    readonly collectorEnabled: boolean
    readonly connection:
      | 'disabled'
      | 'connecting'
      | 'connected'
      | 'reconnecting'
      | 'stale'
      | 'stopped'
      | 'unavailable'
    readonly message: string
  }
  readonly market: {
    readonly source: string
    readonly instrumentId: 'BTC-EUR'
    readonly status: 'live' | 'stale' | 'invalid' | 'gap'
    readonly price: number
    readonly eventTime: number
    readonly receivedTime: number
    readonly displayTime: number
    readonly freshness: {
      readonly ageMs: number
      readonly isStale: boolean
      readonly clockInverted: boolean
    }
    readonly sequence?: number
  } | null
  readonly observability: {
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
  } | null
  readonly news?: {
    readonly status: 'disabled' | 'loading' | 'ready' | 'stale' | 'error'
    readonly items: readonly {
      readonly id: string
      readonly version: string
      readonly source: string
      readonly title: string
      readonly url: string
      readonly publishedAt: number
      readonly ingestedAt: number
      readonly displayedAt: number
      readonly licenseStatus: string
      readonly important: boolean
      readonly summary: string
      readonly tradeIntent: 'buy' | 'sell' | 'neutral'
      readonly freshness: {
        readonly ageMs: number
        readonly isStale: boolean
      }
    }[]
    readonly lastSuccessfulAt?: number
    readonly error?: string
  }
  readonly summaries: {
    readonly analysis: {
      readonly status: 'unavailable'
      readonly reason: string
    }
    readonly forecast:
      | {
          readonly status: 'available'
          readonly id: string
          readonly version: string
          readonly horizon: string
          readonly createdAt: number
          readonly abstained: boolean
          readonly probabilityUp: number
          readonly probabilityDown: number
          readonly probabilityFlat: number
        }
      | { readonly status: 'unavailable'; readonly reason: string }
    readonly news:
      | {
          readonly status: 'available'
          readonly totalCount: number
          readonly relevantCount: number
          readonly latestPublishedAt: number
        }
      | { readonly status: 'unavailable'; readonly reason: string }
  }
}

export interface IntelligenceStreamEvent {
  readonly version: 'intelligence-stream.v1'
  readonly type: 'snapshot'
  readonly id: string
  readonly serverTime: number
  readonly snapshot: IntelligenceStreamSnapshot
}

export interface SseEventSource {
  onopen: (() => void) | null
  onerror: (() => void) | null
  addEventListener: (
    name: string,
    listener: (event: MessageEvent<string>) => void,
  ) => void
  removeEventListener: (
    name: string,
    listener: (event: MessageEvent<string>) => void,
  ) => void
  close: () => void
}

export interface UseIntelligenceStreamResult {
  readonly status: IntelligenceStreamStatus
  readonly snapshot: IntelligenceStreamSnapshot | null
  readonly error: Error | null
  readonly reconnectAttempt: number
  readonly clientReceivedAtMs: number | null
  readonly transportStatus: IntelligenceStreamTransportStatus
}

export function useIntelligenceStream(
  options: {
    readonly url?: string
    readonly eventSourceFactory?: (url: string) => SseEventSource
    readonly reconnectMinMs?: number
    readonly reconnectMaxMs?: number
  } = {},
): UseIntelligenceStreamResult {
  const browserSupportsSse =
    options.eventSourceFactory !== undefined ||
    typeof EventSource !== 'undefined'
  const [state, setState] = useState<UseIntelligenceStreamResult>({
    status: browserSupportsSse ? 'loading' : 'disabled',
    snapshot: null,
    error: null,
    reconnectAttempt: 0,
    clientReceivedAtMs: null,
    transportStatus: browserSupportsSse ? 'connecting' : 'disabled',
  })

  useEffect(() => {
    const configuredBaseUrl =
      options.url !== undefined
        ? options.url
        : import.meta.env.DEV
          ? undefined
          : (import.meta.env.VITE_INTELLIGENCE_SERVER_URL ??
            import.meta.env.VITE_GEMINI_SERVER_URL)
    const streamUrl =
      configuredBaseUrl === undefined
        ? '/api/intelligence/stream?instrumentId=BTC-EUR'
        : `${configuredBaseUrl.replace(/\/$/, '')}/api/intelligence/stream?instrumentId=BTC-EUR`
    const factory =
      options.eventSourceFactory ??
      ((url: string) => new EventSource(url) as unknown as SseEventSource)
    const minDelay = options.reconnectMinMs ?? 500
    const maxDelay = options.reconnectMaxMs ?? 10_000
    let disposed = false
    let source: SseEventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    if (
      options.eventSourceFactory === undefined &&
      typeof EventSource === 'undefined'
    ) {
      return
    }

    const closeSource = () => {
      if (source === null) return
      source.removeEventListener('intelligence.snapshot', onMessage)
      source.close()
      source = null
    }

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== null) return
      const delay = Math.min(maxDelay, minDelay * 2 ** attempt)
      attempt += 1
      setState((current) => ({ ...current, reconnectAttempt: attempt }))
      retryTimer = setTimeout(() => {
        retryTimer = null
        connect()
      }, delay)
    }

    const fail = (error: Error) => {
      if (disposed) return
      closeSource()
      setState((current) => ({
        ...current,
        error,
        transportStatus: 'reconnecting',
      }))
      scheduleReconnect()
    }

    const onMessage = (message: MessageEvent<string>) => {
      try {
        const event = parseIntelligenceStreamEvent(JSON.parse(message.data))
        const status = statusFor(event.snapshot)
        setState((current) => ({
          ...current,
          status,
          snapshot: event.snapshot,
          error: null,
          reconnectAttempt: attempt,
          clientReceivedAtMs: Date.now(),
        }))
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error('Evento SSE de inteligencia inválido.'),
        )
      }
    }

    const connect = () => {
      if (disposed) return
      setState((current) => ({ ...current, transportStatus: 'connecting' }))
      try {
        source = factory(streamUrl)
        source.onopen = () => {
          attempt = 0
          setState((current) => ({
            ...current,
            error: null,
            transportStatus: 'connected',
          }))
        }
        source.onerror = () =>
          fail(new Error('La conexión SSE de inteligencia se interrumpió.'))
        source.addEventListener('intelligence.snapshot', onMessage)
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error('No se pudo abrir la conexión SSE de inteligencia.'),
        )
      }
    }

    connect()
    return () => {
      disposed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      closeSource()
    }
  }, [
    options.eventSourceFactory,
    options.reconnectMaxMs,
    options.reconnectMinMs,
    options.url,
  ])

  return state
}

export function parseIntelligenceStreamEvent(
  input: unknown,
): IntelligenceStreamEvent {
  if (!isRecord(input) || input.version !== 'intelligence-stream.v1')
    throw new Error('Evento SSE de inteligencia inválido: versión.')
  if (
    input.type !== 'snapshot' ||
    typeof input.id !== 'string' ||
    !isTimestamp(input.serverTime) ||
    !isSnapshot(input.snapshot)
  )
    throw new Error('Evento SSE de inteligencia inválido: payload.')
  return input as unknown as IntelligenceStreamEvent
}

function statusFor(
  snapshot: IntelligenceStreamSnapshot,
): IntelligenceStreamStatus {
  if (snapshot.pipeline.status === 'disabled') return 'disabled'
  if (
    snapshot.pipeline.status === 'stale' ||
    snapshot.pipeline.status === 'gap'
  )
    return 'stale'
  return 'ready'
}

function isSnapshot(input: unknown): input is IntelligenceStreamSnapshot {
  if (!isRecord(input)) return false
  if (
    input.version !== 'intelligence-snapshot.v1' ||
    input.instrumentId !== 'BTC-EUR' ||
    !isTimestamp(input.generatedAt) ||
    !isRecord(input.pipeline) ||
    ![
      'disabled',
      'unavailable',
      'connecting',
      'ready',
      'stale',
      'gap',
    ].includes(input.pipeline.status as string) ||
    typeof input.pipeline.collectorEnabled !== 'boolean' ||
    ![
      'disabled',
      'connecting',
      'connected',
      'reconnecting',
      'stale',
      'stopped',
      'unavailable',
    ].includes(input.pipeline.connection as string) ||
    typeof input.pipeline.message !== 'string' ||
    !isRecord(input.summaries) ||
    !isAnalysisSummary(input.summaries.analysis) ||
    !isForecastSummary(input.summaries.forecast) ||
    !isNewsSummary(input.summaries.news)
  )
    return false
  return (
    (input.market === null || isMarket(input.market)) &&
    isObservability(input.observability) &&
    (input.news === undefined || isNewsSnapshot(input.news))
  )
}

function isNewsSnapshot(input: unknown): boolean {
  if (!isRecord(input) || !Array.isArray(input.items)) return false
  if (
    !['disabled', 'loading', 'ready', 'stale', 'error'].includes(
      input.status as string,
    )
  )
    return false
  if (
    input.lastSuccessfulAt !== undefined &&
    !isTimestamp(input.lastSuccessfulAt)
  )
    return false
  if (input.error !== undefined && typeof input.error !== 'string') return false
  return input.items.every((item) => {
    if (!isRecord(item)) return false
    return (
      typeof item.id === 'string' &&
      typeof item.version === 'string' &&
      typeof item.source === 'string' &&
      typeof item.title === 'string' &&
      typeof item.url === 'string' &&
      isHttpsUrl(item.url) &&
      isTimestamp(item.publishedAt) &&
      isTimestamp(item.ingestedAt) &&
      isTimestamp(item.displayedAt) &&
      [
        'official_public',
        'licensed',
        'permission_required',
        'unknown',
      ].includes(item.licenseStatus as string) &&
      typeof item.important === 'boolean' &&
      typeof item.summary === 'string' &&
      item.summary.trim() !== '' &&
      sentenceCount(item.summary) <= 5 &&
      typeof item.tradeIntent === 'string' &&
      ['buy', 'sell', 'neutral'].includes(item.tradeIntent) &&
      isRecord(item.freshness) &&
      isNonNegative(item.freshness.ageMs) &&
      typeof item.freshness.isStale === 'boolean'
    )
  })
}

function isHttpsUrl(input: string): boolean {
  try {
    return new URL(input).protocol === 'https:'
  } catch {
    return false
  }
}

function sentenceCount(input: string): number {
  return input.trim() === ''
    ? 0
    : input
        .trim()
        .split(/(?<=[.!?])\s+/u)
        .filter(Boolean).length
}

function isMarket(input: unknown): boolean {
  if (!isRecord(input) || input.instrumentId !== 'BTC-EUR') return false
  return (
    typeof input.source === 'string' &&
    ['live', 'stale', 'invalid', 'gap'].includes(input.status as string) &&
    typeof input.price === 'number' &&
    Number.isFinite(input.price) &&
    isTimestamp(input.eventTime) &&
    isTimestamp(input.receivedTime) &&
    isTimestamp(input.displayTime) &&
    isRecord(input.freshness) &&
    isNonNegative(input.freshness.ageMs) &&
    typeof input.freshness.isStale === 'boolean' &&
    typeof input.freshness.clockInverted === 'boolean'
  )
}

function isObservability(input: unknown): boolean {
  if (input === null) return true
  if (!isRecord(input) || !isNonNegativeInteger(input.windowSize)) return false
  if (
    !isRecord(input.latencyMs) ||
    !isNonNegativeInteger(input.latencyMs.count)
  )
    return false
  if (
    !isNullableNonNegative(input.latencyMs.p50) ||
    !isNullableNonNegative(input.latencyMs.p95)
  )
    return false
  if (
    !isRecord(input.stale) ||
    !isNonNegativeInteger(input.stale.staleCount) ||
    !isNonNegativeInteger(input.stale.totalCount) ||
    !isNullableRate(input.stale.rate)
  )
    return false
  return (
    isRecord(input.gaps) &&
    isNonNegativeInteger(input.gaps.gapCount) &&
    isNonNegativeInteger(input.gaps.expectedOpportunities) &&
    isNullableRate(input.gaps.rate) &&
    typeof input.gaps.sequenceAvailable === 'boolean'
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

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function isTimestamp(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
}

function isNonNegativeInteger(input: unknown): input is number {
  return isTimestamp(input)
}

function isNonNegative(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0
}

function isNullableNonNegative(input: unknown): input is number | null {
  return input === null || isNonNegative(input)
}

function isNullableRate(input: unknown): input is number | null {
  return input === null || (isNonNegative(input) && input <= 1)
}
