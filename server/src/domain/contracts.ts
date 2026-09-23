import {
  finiteNonNegative,
  invalid,
  isRecord,
  issue,
  nonEmptyString,
  valid,
  type ValidationResult,
} from '../platform/validation.ts'

export type TimestampMs = number & { readonly __unit: 'epoch-milliseconds' }

export function parseTimestampMs(
  input: unknown,
  path = 'timestamp',
): ValidationResult<TimestampMs> {
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    !Number.isSafeInteger(input) ||
    input < 0
  ) {
    return invalid([
      issue(
        'invalid_timestamp',
        path,
        'Timestamp must be a finite, non-negative safe integer in epoch milliseconds.',
      ),
    ])
  }
  return valid(input as TimestampMs)
}

export type SupportedInstrumentId = 'BTC-EUR'

export type MarketDataStatus = 'live' | 'stale' | 'invalid' | 'gap'

export interface DataFreshness {
  readonly ageMs: number
  readonly isStale: boolean
  readonly clockInverted: boolean
}

export interface MarketDataEnvelope<TPayload> {
  readonly source: string
  readonly symbol: 'BTC-EUR'
  readonly instrumentId: SupportedInstrumentId
  readonly eventTime: TimestampMs
  readonly receivedTime: TimestampMs
  readonly displayTime: TimestampMs
  readonly sequence?: number
  readonly payload: TPayload
  readonly status: MarketDataStatus
  readonly freshness: DataFreshness
}

export interface MarketCollectorInput {
  readonly instrumentId: SupportedInstrumentId
  readonly signal?: AbortSignal
}

export interface MarketDataCollector<TRaw> {
  readonly domain: 'market'
  readonly source: string
  collect(
    instrumentId: SupportedInstrumentId,
    signal?: AbortSignal,
  ): Promise<readonly TRaw[]>
}

export interface MarketNormalizerInput<TRaw> {
  readonly raw: TRaw
  readonly instrumentId: SupportedInstrumentId
  readonly receivedTime: TimestampMs
  readonly displayTime: TimestampMs
}

export interface MarketDataNormalizer<TRaw, TPayload> {
  readonly domain: 'market'
  normalize(
    input: MarketNormalizerInput<TRaw>,
  ): ValidationResult<MarketDataEnvelope<TPayload>>
}

export type NewsSourceLevel =
  'official_primary' | 'licensed_reporting' | 'unverified_social'

export type LicenseStatus =
  'official_public' | 'licensed' | 'permission_required' | 'unknown'

export type CorrectionStatus =
  'original' | 'corrected' | 'retracted' | 'unknown'

export type PermittedNewsContent =
  | { readonly kind: 'metadata_only' }
  | { readonly kind: 'excerpt' | 'summary'; readonly text: string }

export type NewsRelevance = 'relevant' | 'not_relevant' | 'uncertain'

export type NewsEventTaxonomy =
  | 'macro'
  | 'regulation'
  | 'market_structure'
  | 'technology'
  | 'exchange'
  | 'security'
  | 'other'

export interface NewsMetadata {
  readonly title: string
  readonly author?: string
  readonly category?: string
  readonly feedUrl?: string
  readonly sourceSummary?: string
  readonly important?: boolean
  readonly tradeIntent?: 'buy' | 'sell' | 'neutral'
}

export interface NewsEvidence {
  readonly instrumentId: SupportedInstrumentId
  readonly source: string
  readonly sourceLevel: NewsSourceLevel
  readonly sourceItemId: string
  readonly url: string
  readonly publishedAt: TimestampMs
  readonly ingestedAt: TimestampMs
  readonly retrievedAt: TimestampMs
  readonly contentHash: string
  readonly licenseStatus: LicenseStatus
  readonly correctionStatus: CorrectionStatus
  readonly correctionOfSourceItemId?: string
  readonly relevance: NewsRelevance
  readonly relevanceRuleVersion: string
  readonly taxonomy: NewsEventTaxonomy
  readonly taxonomyRuleVersion: string
  readonly metadata: NewsMetadata
  readonly content: PermittedNewsContent
}

export interface NewsEvidenceRecord extends NewsEvidence {
  readonly id: string
  readonly version: string
}

export type NewsStatus = 'live' | 'stale' | 'invalid'

export interface NewsEnvelope {
  readonly instrumentId: SupportedInstrumentId
  readonly status: NewsStatus
  readonly evidence: NewsEvidence
}

export interface NewsCollector<TRaw> {
  readonly domain: 'news'
  readonly source: string
  collect(
    instrumentId: SupportedInstrumentId,
    signal?: AbortSignal,
  ): Promise<readonly TRaw[]>
}

export interface NewsNormalizerInput<TRaw> {
  readonly raw: TRaw
  readonly evidence: NewsEvidence
}

export interface NewsNormalizer<TRaw> {
  readonly domain: 'news'
  normalize(input: NewsNormalizerInput<TRaw>): ValidationResult<NewsEnvelope>
}

export type ForecastHorizon = '15m' | '1h' | '4h' | '24h'

export type ForecastSourceMode = 'shadow_live' | 'historical_replay'

export interface ExpectedRange {
  readonly lower: number
  readonly upper: number
}

export interface TechnicalFeatureSnapshot {
  readonly version: string
  readonly asOfTimestamp: TimestampMs
  readonly isClosed: boolean
  readonly ready: boolean
  readonly warmUp: {
    readonly requiredCandles: number
    readonly availableCandles: number
    readonly missingCandles: number
  }
  readonly values: Readonly<Record<string, number>>
  /**
   * Additive lineage only: which parameter set produced the feature values.
   * Absent on records written before the simulations harness existed; never
   * required by validation so existing schemas keep working unchanged.
   */
  readonly paramSetVersion?: string
}

export interface NewsEvidenceReference {
  readonly id: string
  readonly version: string
  readonly publishedAt: TimestampMs
  readonly ingestedAt: TimestampMs
  readonly contentHash: string
}

export interface GapMetrics {
  readonly gapCount: number
  readonly expectedOpportunities: number
  readonly rate: number | null
  readonly sequenceAvailable: boolean
}

export interface ForecastRecord {
  readonly id: string
  readonly version: string
  readonly instrumentId: SupportedInstrumentId
  readonly createdAt: TimestampMs
  readonly asOfTimestamp: TimestampMs
  readonly eventCutoff: TimestampMs
  readonly horizon: ForecastHorizon
  readonly referencePrice: number
  readonly probabilityUp: number
  readonly probabilityDown: number
  readonly probabilityFlat: number
  readonly expectedRange?: ExpectedRange
  readonly expectedReturn?: number
  readonly technicalFeatureSnapshot: TechnicalFeatureSnapshot
  readonly newsEvidenceReferences: readonly NewsEvidenceReference[]
  readonly dataFreshness: DataFreshness
  readonly dataGaps: GapMetrics
  readonly modelVersion: string
  readonly ruleVersion: string
  readonly sourceMode: ForecastSourceMode
  readonly replayRunId: string | null
  readonly abstained: boolean
  readonly abstentionReason?: string
  readonly contentHash: string
}

export type ForecastOutcomeLabel = 'up' | 'down' | 'flat'

export interface ForecastOutcome {
  readonly id: string
  readonly version: string
  readonly forecastId: string
  readonly forecastVersion: string
  readonly evaluatedAt: TimestampMs
  readonly observedEventTime: TimestampMs
  readonly observedDataHash: string
  readonly observedDataIsClosed: boolean
  readonly observedPrice: number
  readonly label: ForecastOutcomeLabel
  readonly realizedReturn: number
  readonly neutralBand: number
  readonly costs?: ForecastCostParameters
  readonly brierScore: number
  readonly logLoss?: number
  readonly returnAbsoluteError?: number
  readonly rangeAbsoluteError?: number
  readonly contentHash: string
}

export interface ForecastCostParameters {
  readonly version: string
  readonly commissionRate: number
  readonly slippageRate: number
}

export function validateMarketDataEnvelope(
  input: unknown,
): ValidationResult<MarketDataEnvelope<unknown>> {
  if (!isRecord(input)) {
    return invalid([
      issue(
        'invalid_envelope',
        'envelope',
        'Market envelope must be an object.',
      ),
    ])
  }

  const issues = []
  if (!nonEmptyString(input.source))
    issues.push(issue('empty_source', 'source', 'Source is required.'))
  if (input.symbol !== 'BTC-EUR') {
    issues.push(
      issue('unsupported_instrument', 'symbol', 'Only BTC-EUR is supported.'),
    )
  }
  if (input.instrumentId !== 'BTC-EUR') {
    issues.push(
      issue(
        'unsupported_instrument',
        'instrumentId',
        'Only BTC-EUR is supported.',
      ),
    )
  }

  const eventTime = parseTimestampMs(input.eventTime, 'eventTime')
  const receivedTime = parseTimestampMs(input.receivedTime, 'receivedTime')
  const displayTime = parseTimestampMs(input.displayTime, 'displayTime')
  for (const result of [eventTime, receivedTime, displayTime]) {
    if (!result.valid) issues.push(...result.issues)
  }
  if (
    eventTime.valid &&
    receivedTime.valid &&
    receivedTime.value < eventTime.value
  ) {
    issues.push(
      issue(
        'received_before_event',
        'receivedTime',
        'Received time cannot precede event time.',
      ),
    )
  }
  if (
    receivedTime.valid &&
    displayTime.valid &&
    displayTime.value < receivedTime.value
  ) {
    issues.push(
      issue(
        'display_before_received',
        'displayTime',
        'Display time cannot precede received time.',
      ),
    )
  }

  const statuses: readonly MarketDataStatus[] = [
    'live',
    'stale',
    'invalid',
    'gap',
  ]
  if (
    typeof input.status !== 'string' ||
    !statuses.includes(input.status as MarketDataStatus)
  ) {
    issues.push(
      issue('invalid_status', 'status', 'Market status is not supported.'),
    )
  }
  if (input.payload === undefined || input.payload === null) {
    issues.push(
      issue('payload_required', 'payload', 'Normalized payload is required.'),
    )
  }
  if (
    input.sequence !== undefined &&
    (typeof input.sequence !== 'number' ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0)
  ) {
    issues.push(
      issue(
        'invalid_sequence',
        'sequence',
        'Sequence must be a non-negative safe integer.',
      ),
    )
  }

  const freshness = input.freshness
  if (!isRecord(freshness)) {
    issues.push(
      issue(
        'freshness_required',
        'freshness',
        'Derived freshness is required.',
      ),
    )
  } else {
    if (!finiteNonNegative(freshness.ageMs)) {
      issues.push(
        issue(
          'invalid_freshness_age',
          'freshness.ageMs',
          'Freshness age must be finite and non-negative.',
        ),
      )
    }
    if (typeof freshness.isStale !== 'boolean') {
      issues.push(
        issue(
          'invalid_freshness_state',
          'freshness.isStale',
          'Freshness state must be boolean.',
        ),
      )
    }
    if (typeof freshness.clockInverted !== 'boolean') {
      issues.push(
        issue(
          'invalid_clock_state',
          'freshness.clockInverted',
          'Clock state must be boolean.',
        ),
      )
    }
    if (
      eventTime.valid &&
      displayTime.valid &&
      finiteNonNegative(freshness.ageMs)
    ) {
      const inverted = displayTime.value < eventTime.value
      const expectedAge = inverted ? 0 : displayTime.value - eventTime.value
      if (
        freshness.ageMs !== expectedAge ||
        freshness.clockInverted !== inverted
      ) {
        issues.push(
          issue(
            'freshness_mismatch',
            'freshness',
            'Freshness must be derived from displayTime minus eventTime.',
          ),
        )
      }
    }
  }

  if (issues.length > 0) return invalid(issues)
  const eventMs = eventTime.valid ? eventTime.value : (0 as TimestampMs)
  const receivedMs = receivedTime.valid
    ? receivedTime.value
    : (0 as TimestampMs)
  const displayMs = displayTime.valid ? displayTime.value : (0 as TimestampMs)
  return valid({
    source: input.source as string,
    symbol: 'BTC-EUR',
    instrumentId: 'BTC-EUR',
    eventTime: eventMs,
    receivedTime: receivedMs,
    displayTime: displayMs,
    ...(input.sequence === undefined
      ? {}
      : { sequence: input.sequence as number }),
    payload: input.payload,
    status: input.status as MarketDataStatus,
    freshness: input.freshness as DataFreshness,
  })
}
