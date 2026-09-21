import type {
  ForecastHorizon,
  ForecastOutcome,
  ForecastRecord,
  NewsEvidence,
  NewsEvidenceReference,
  TimestampMs,
} from '../contracts.ts'
import { contentHashFor } from '../forecast-hashing.ts'
import { contentHashForNewsEvidence } from '../news/rss-normalizer.ts'
import { HORIZON_MS } from '../forecast-evaluator.ts'

export interface ForecastFixtureOverrides {
  readonly id?: string
  readonly version?: string
  readonly horizon?: ForecastHorizon
  readonly asOfTimestamp?: number
  readonly createdAt?: number
  readonly abstained?: boolean
  readonly abstentionReason?: string
  readonly probabilityUp?: number
  readonly probabilityDown?: number
  readonly probabilityFlat?: number
  readonly expectedReturn?: number
  readonly expectedRange?: { readonly lower: number; readonly upper: number }
  readonly stale?: boolean
  readonly clockInverted?: boolean
  readonly gapCount?: number
  readonly newsEvidenceReferences?: readonly NewsEvidenceReference[]
  readonly atrRatio?: number
}

const ts = (value: number): TimestampMs => value as TimestampMs

export function makeForecast(
  overrides: ForecastFixtureOverrides = {},
): ForecastRecord {
  const horizon: ForecastHorizon = overrides.horizon ?? '1h'
  const asOfTimestamp = ts(overrides.asOfTimestamp ?? 1_000_000)
  const createdAt = ts(overrides.createdAt ?? asOfTimestamp)
  const abstained = overrides.abstained ?? false
  const referencePrice = 100
  const values: Record<string, number> = {
    sma: 99,
    rsi: 60,
    macdHistogram: 1,
    structuralSlope: 1,
  }
  const atrRatio = overrides.atrRatio
  if (atrRatio !== undefined) values.atr = atrRatio * referencePrice
  const withoutHash = {
    id: overrides.id ?? 'forecast-fixture',
    version: overrides.version ?? '1',
    instrumentId: 'BTC-EUR' as const,
    createdAt,
    asOfTimestamp,
    eventCutoff: asOfTimestamp,
    horizon,
    referencePrice,
    probabilityUp: abstained ? 1 / 3 : (overrides.probabilityUp ?? 0.5),
    probabilityDown: abstained ? 1 / 3 : (overrides.probabilityDown ?? 0.25),
    probabilityFlat: abstained ? 1 / 3 : (overrides.probabilityFlat ?? 0.25),
    ...(overrides.expectedReturn === undefined
      ? {}
      : { expectedReturn: overrides.expectedReturn }),
    ...(overrides.expectedRange === undefined
      ? {}
      : { expectedRange: overrides.expectedRange }),
    technicalFeatureSnapshot: {
      version: 'technical-features.v1',
      asOfTimestamp,
      isClosed: true,
      ready: true,
      warmUp: { requiredCandles: 1, availableCandles: 1, missingCandles: 0 },
      values,
    },
    newsEvidenceReferences: overrides.newsEvidenceReferences ?? [],
    dataFreshness: {
      ageMs: ts(
        overrides.stale === true || overrides.clockInverted === true
          ? 5_000_000
          : 100,
      ),
      isStale: overrides.stale ?? false,
      clockInverted: overrides.clockInverted ?? false,
    },
    dataGaps: {
      gapCount: overrides.gapCount ?? 0,
      expectedOpportunities: 1,
      rate: (overrides.gapCount ?? 0) > 0 ? (overrides.gapCount ?? 0) : 0,
      sequenceAvailable: true,
    },
    modelVersion: 'deterministic-baseline.v1',
    ruleVersion: 'technical-direction.v1',
    abstained,
    ...(abstained
      ? { abstentionReason: overrides.abstentionReason ?? 'warmup_incomplete' }
      : {}),
  }
  return { ...withoutHash, contentHash: contentHashFor(withoutHash) }
}

export interface OutcomeFixtureOverrides {
  readonly evaluatedAt?: number
  readonly observedEventTime?: number
  readonly observedDataHash?: string
  readonly observedDataIsClosed?: boolean
  readonly label?: 'up' | 'down' | 'flat'
  readonly observedPrice?: number
  readonly realizedReturn?: number
}

export function makeOutcome(
  forecast: ForecastRecord,
  overrides: OutcomeFixtureOverrides = {},
): ForecastOutcome {
  const horizonEnd = forecast.asOfTimestamp + HORIZON_MS[forecast.horizon]
  const evaluatedAt = ts(overrides.evaluatedAt ?? horizonEnd)
  const observedEventTime = ts(overrides.observedEventTime ?? evaluatedAt)
  const label = overrides.label ?? 'up'
  const observedPrice =
    overrides.observedPrice ??
    forecast.referencePrice * (1 + (overrides.realizedReturn ?? 0.01))
  const realizedReturn = observedPrice / forecast.referencePrice - 1
  const withoutHash = {
    id: `${forecast.id}:${forecast.version}:observed`,
    version: '1',
    forecastId: forecast.id,
    forecastVersion: forecast.version,
    evaluatedAt,
    observedEventTime,
    observedDataHash: overrides.observedDataHash ?? 'observed-data-fixture',
    observedDataIsClosed: overrides.observedDataIsClosed ?? true,
    observedPrice,
    label,
    realizedReturn: overrides.realizedReturn ?? realizedReturn,
    neutralBand: 0.0015,
    brierScore: 0,
  }
  return { ...withoutHash, contentHash: contentHashFor(withoutHash) }
}

export function makeNewsReference(
  overrides: Partial<NewsEvidenceReference> = {},
): NewsEvidenceReference {
  return {
    id: overrides.id ?? 'news-1',
    version: overrides.version ?? '1',
    publishedAt: ts(overrides.publishedAt ?? 900_000),
    ingestedAt: ts(overrides.ingestedAt ?? 950_000),
    contentHash: overrides.contentHash ?? 'news-evidence-hash-1',
  }
}

export function makeNewsEvidence(
  overrides: Partial<NewsEvidence> = {},
): NewsEvidence {
  const base: NewsEvidence = {
    instrumentId: 'BTC-EUR',
    source: 'sec',
    sourceLevel: 'official_primary',
    sourceItemId: 'sec-1',
    url: 'https://www.sec.gov/newsroom/press-releases/2026-1',
    publishedAt: ts(overrides.publishedAt ?? 900_000),
    ingestedAt: ts(overrides.ingestedAt ?? 950_000),
    retrievedAt: ts(overrides.retrievedAt ?? 960_000),
    contentHash: '',
    licenseStatus: 'official_public',
    correctionStatus: 'original',
    relevance: 'relevant',
    relevanceRuleVersion: 'news-relevance.v1',
    taxonomy: 'regulation',
    taxonomyRuleVersion: 'news-taxonomy.v1',
    metadata: { title: 'Bitcoin and EUR regulation' },
    content: { kind: 'metadata_only' },
    ...overrides,
  }
  return { ...base, contentHash: contentHashForNewsEvidence(base) }
}
