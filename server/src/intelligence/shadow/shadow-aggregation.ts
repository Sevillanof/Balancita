import type {
  ForecastHorizon,
  ForecastOutcome,
  ForecastRecord,
} from '../contracts.ts'
import { contentHashFor } from '../forecast-hashing.ts'
import { HORIZON_MS } from '../forecast-evaluator.ts'
import {
  calculateComparativeMetrics,
  type ComparativeMetricEntry,
  type EvaluatedSignal,
} from '../comparison-metrics.ts'
import type { ComparativeMetricsSegment } from '../comparison-metrics.ts'
import type { ShadowDerivedRegime } from './shadow-contracts.ts'
import { SHADOW_AGGREGATION_RULE_VERSION } from './shadow-contracts.ts'

export const REGIME_THRESHOLD_RATIO = 0.015
const TECHNICAL_FRESHNESS_TOLERANCE_MS = 60_000

export interface ShadowAggregationCycle {
  readonly run: Readonly<{
    readonly plannedEndAt: number
    readonly versions: Readonly<{
      readonly aggregationRuleVersion?: string
    }>
  }>
  readonly inputs: {
    readonly forecasts: readonly ForecastRecord[]
    readonly outcomes: readonly ForecastOutcome[]
    readonly asOfTimestamp: number
    readonly now: number
    readonly storedNewsEvidenceCount: number
  }
}

export interface ShadowFreshnessSummary {
  readonly forecastCount: number
  readonly staleCount: number
  readonly realtimeCount: number
  readonly staleRate: number | null
  readonly maxFreshnessAgeMs: number | null
  readonly totalGapCount: number
  readonly gapRate: number | null
}

export interface ShadowMissingness {
  readonly dueForecastCount: number
  readonly evaluatedForecastCount: number
  readonly missingOutcomeCount: number
}

export interface ShadowComparativeTechnical {
  readonly signals: number
  readonly agreement: number
  readonly disagreement: number
  readonly abstention: number
  readonly callRate: number | null
  readonly directionalAccuracy: number | null
  readonly brierScore: number | null
  readonly logLoss: number | null
  readonly returnMae: number | null
  readonly rangeMae: number | null
}

export interface ShadowComparativeNews {
  readonly available: boolean
  readonly unavailableReason: string
  readonly signals: number
  readonly explained: boolean
}

export interface ShadowComparative {
  readonly computationalVersion: typeof SHADOW_AGGREGATION_RULE_VERSION
  readonly computedAt: number
  readonly signals: number
  readonly agreement: number
  readonly disagreement: number
  readonly abstention: number
  readonly available: boolean
  readonly explained: boolean
  readonly technical: ShadowComparativeTechnical
  readonly news: ShadowComparativeNews
  readonly baseline: {
    readonly ruleVersion: string
    readonly parameters: { readonly thresholdRatio: number }
  }
  readonly segments: readonly ComparativeMetricsSegment[]
  readonly limitations: readonly string[]
  readonly contentHash: string
}

export interface ShadowSegment {
  readonly key: string
  readonly horizon?: ForecastHorizon
  readonly regime?: ShadowDerivedRegime | 'unspecified'
  readonly forecastCount: number
  readonly evaluatedOutcomeCount: number
  readonly agreement: number
  readonly disagreement: number
  readonly abstention: number
  readonly directionalAccuracy: number | null
}

export interface ShadowMeta {
  readonly regime: ShadowDerivedRegime | 'unspecified'
  readonly regimeRuleVersion: string
  readonly referencePriceBase: string
}

export interface ShadowMetrics {
  readonly computationalVersion: typeof SHADOW_AGGREGATION_RULE_VERSION
  readonly evaluated: boolean
  readonly meta: ShadowMeta
  readonly coverage: {
    readonly forecastCount: number
    readonly evaluatedOutcomeCount: number
  }
  readonly outcomes: {
    readonly outcomeCount: number
    readonly outcomeForecastIds: readonly string[]
  }
  readonly technical: {
    readonly staleCount: number
    readonly realtimeCount: number
  }
  readonly freshness: ShadowFreshnessSummary
  readonly missingness: ShadowMissingness
  readonly news: {
    readonly available: boolean
    readonly unavailableReason: string
    readonly evidenceCount: number
  }
  readonly segments: {
    readonly all: ShadowSegment
    readonly perRegime: Readonly<Record<string, ShadowSegment>>
    readonly perHorizon: Readonly<Record<string, ShadowSegment>>
  }
  readonly comparative: ShadowComparative
}

interface SeededEntry {
  readonly entry: ComparativeMetricEntry
  readonly forecastKey: string
}

function seededEntries(
  windowed: readonly ForecastRecord[],
  outcomes: readonly ForecastOutcome[],
  asOfTimestamp: number,
): readonly SeededEntry[] {
  const byKey = new Map<string, ForecastRecord>()
  windowed.forEach((forecast) => {
    byKey.set(`${forecast.id}:${forecast.version}`, forecast)
  })
  const seeded: SeededEntry[] = []
  outcomes.forEach((outcome) => {
    const forecast = byKey.get(
      `${outcome.forecastId}:${outcome.forecastVersion}`,
    )
    if (forecast === undefined) return
    if (!Number.isFinite(outcome.realizedReturn))
      throw new Error(
        `Shadow outcome ${outcome.forecastId}:${outcome.forecastVersion} has a non-finite realizedReturn.`,
      )
    const horizonEnd = forecast.asOfTimestamp + HORIZON_MS[forecast.horizon]
    if (horizonEnd > asOfTimestamp) return
    if (outcome.evaluatedAt < horizonEnd) return
    if (outcome.observedEventTime < horizonEnd) return
    seeded.push({
      forecastKey: `${forecast.id}:${forecast.version}`,
      entry: {
        horizon: forecast.horizon,
        regime: derivedShadowRegime(forecast),
        technical: technicalSignalFrom(forecast),
        news: null,
        outcome: {
          label: outcome.label,
          realizedReturn: outcome.realizedReturn,
          observedPrice: outcome.observedPrice,
        },
      },
    })
  })
  return seeded
}

function technicalSignalFrom(
  forecast: ForecastRecord,
): ComparativeMetricEntry['technical'] {
  if (forecast.abstained)
    return {
      status: 'abstain',
      ...(forecast.abstentionReason === undefined
        ? {}
        : { abstentionReasons: [forecast.abstentionReason] }),
    }
  const probabilities = {
    probabilityUp: forecast.probabilityUp,
    probabilityDown: forecast.probabilityDown,
    probabilityFlat: forecast.probabilityFlat,
  }
  const signal: EvaluatedSignal = {
    status: 'scored',
    probabilities,
    ...(forecast.expectedReturn === undefined
      ? {}
      : { expectedReturn: forecast.expectedReturn }),
    ...(forecast.expectedRange === undefined
      ? {}
      : { expectedRange: forecast.expectedRange }),
  }
  return signal
}

export function derivedShadowRegime(
  forecast: ForecastRecord,
): ShadowDerivedRegime | 'unspecified' {
  const ratio = atrRatioOf(forecast)
  if (ratio === null) return 'unspecified'
  return ratio >= REGIME_THRESHOLD_RATIO ? 'high_volatility' : 'low_volatility'
}

function atrRatioOf(forecast: ForecastRecord): number | null {
  const values = forecast.technicalFeatureSnapshot?.values ?? {}
  const atr = values.atr
  const reference = forecast.referencePrice
  if (
    typeof atr !== 'number' ||
    typeof reference !== 'number' ||
    reference <= 0
  )
    return null
  return atr / reference
}

function buildComparative(
  entries: readonly ComparativeMetricEntry[],
  computedAt: number,
): ShadowComparative {
  const report = calculateComparativeMetrics(entries)
  const technical = report.sources.technical
  const issued = technical.coverage.issued
  const accurate =
    technical.directionalAccuracy === null
      ? 0
      : Math.round(technical.directionalAccuracy * issued)
  const body = {
    computationalVersion: SHADOW_AGGREGATION_RULE_VERSION,
    computedAt,
    signals: issued,
    agreement: accurate,
    disagreement: issued - accurate - (issued - issued),
    abstention: entries.length - issued,
    available: entries.length > 0,
    explained: report.coverage.agreementRate !== null,
  }
  return {
    ...body,
    technical: {
      signals: issued,
      agreement: accurate,
      disagreement: issued - accurate,
      abstention: entries.length - issued,
      callRate: technical.coverage.coverage,
      directionalAccuracy: technical.directionalAccuracy,
      brierScore: technical.brierScore,
      logLoss: technical.logLoss,
      returnMae: technical.returnMae,
      rangeMae: technical.rangeMae,
    },
    news: {
      available: false,
      unavailableReason: 'news_scores_not_persisted',
      signals: 0,
      explained: false,
    },
    baseline: {
      ruleVersion: 'shadow-baseline.v1',
      parameters: { thresholdRatio: REGIME_THRESHOLD_RATIO },
    },
    segments: report.segments,
    limitations: report.limitations,
    contentHash: contentHashFor(body),
  }
}

function segmentFor(
  key: string,
  entries: readonly ComparativeMetricEntry[],
  forecastCount: number,
  horizon?: ForecastHorizon,
  regime?: ShadowDerivedRegime | 'unspecified',
): ShadowSegment {
  const technical = calculateComparativeMetrics(entries).sources.technical
  const issued = technical.coverage.issued
  const accurate =
    technical.directionalAccuracy === null
      ? 0
      : Math.round(technical.directionalAccuracy * issued)
  return {
    key,
    ...(horizon === undefined ? {} : { horizon }),
    ...(regime === undefined ? {} : { regime }),
    forecastCount,
    evaluatedOutcomeCount: issued,
    agreement: accurate,
    disagreement: issued - accurate,
    abstention: entries.length - issued,
    directionalAccuracy: technical.directionalAccuracy,
  }
}

export function buildShadowMetrics(
  forecasts: readonly ForecastRecord[],
  outcomes: readonly ForecastOutcome[],
  asOfTimestamp: number,
  storedNewsEvidenceCount: number,
): ShadowMetrics {
  const windowed = forecasts.filter(
    (forecast) => forecast.asOfTimestamp <= asOfTimestamp,
  )
  const seeded = seededEntries(windowed, outcomes, asOfTimestamp)
  const entries = seeded.map(({ entry }) => entry)
  const outcomeForecastIds = seeded.map(({ forecastKey }) => forecastKey)

  const dueSet = new Set(
    windowed
      .filter(
        (forecast) =>
          forecast.asOfTimestamp + HORIZON_MS[forecast.horizon] <=
          asOfTimestamp,
      )
      .map((forecast) => `${forecast.id}:${forecast.version}`),
  )

  const staleCount = windowed.filter(
    (forecast) =>
      forecast.dataFreshness?.isStale === true ||
      (forecast.dataFreshness?.ageMs ?? 0) > TECHNICAL_FRESHNESS_TOLERANCE_MS,
  ).length
  const totalGapCount = windowed.reduce(
    (sum, forecast) => sum + (forecast.dataGaps?.gapCount ?? 0),
    0,
  )
  const maxAgeMs = windowed.reduce(
    (maximum, forecast) =>
      maximum === undefined
        ? (forecast.dataFreshness?.ageMs ?? 0)
        : Math.max(maximum, forecast.dataFreshness?.ageMs ?? 0),
    undefined as number | undefined,
  )

  const regimeGroups = new Map<string, ComparativeMetricEntry[]>()
  const horizonGroups = new Map<ForecastHorizon, ComparativeMetricEntry[]>()
  seeded.forEach(({ entry }) => {
    const regimeKey = `${entry.horizon}:${entry.regime ?? 'unspecified'}`
    const regimeGroup = regimeGroups.get(regimeKey) ?? []
    regimeGroup.push(entry)
    regimeGroups.set(regimeKey, regimeGroup)
    const horizonGroup = horizonGroups.get(entry.horizon) ?? []
    horizonGroup.push(entry)
    horizonGroups.set(entry.horizon, horizonGroup)
  })

  const perRegime: Record<string, ShadowSegment> = {}
  for (const [key, group] of [...regimeGroups.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    const separator = key.indexOf(':')
    const horizon = key.slice(0, separator) as ForecastHorizon
    const regime = key.slice(separator + 1) as
      ShadowDerivedRegime | 'unspecified'
    const forecastCount = windowed.filter(
      (forecast) =>
        forecast.horizon === horizon &&
        derivedShadowRegime(forecast) === regime,
    ).length
    perRegime[key] = segmentFor(key, group, forecastCount, horizon, regime)
  }
  const perHorizon: Record<string, ShadowSegment> = {}
  for (const [horizon, group] of [...horizonGroups.entries()].sort()) {
    const forecastCount = windowed.filter(
      (forecast) => forecast.horizon === horizon,
    ).length
    perHorizon[horizon] = segmentFor(horizon, group, forecastCount, horizon)
  }

  const latest = [...windowed].sort(
    (left, right) => right.asOfTimestamp - left.asOfTimestamp,
  )[0]
  const regime =
    latest === undefined
      ? ('unspecified' as const)
      : derivedShadowRegime(latest)

  return {
    computationalVersion: SHADOW_AGGREGATION_RULE_VERSION,
    evaluated: entries.length > 0,
    meta: {
      regime,
      regimeRuleVersion: 'shadow-regime.v1',
      referencePriceBase: 'shadow-baseline.v1',
    },
    coverage: {
      forecastCount: windowed.length,
      evaluatedOutcomeCount: entries.length,
    },
    outcomes: {
      outcomeCount: entries.length,
      outcomeForecastIds,
    },
    technical: {
      staleCount,
      realtimeCount: windowed.length - staleCount,
    },
    freshness: {
      forecastCount: windowed.length,
      staleCount,
      realtimeCount: windowed.length - staleCount,
      staleRate: windowed.length === 0 ? null : staleCount / windowed.length,
      maxFreshnessAgeMs: maxAgeMs ?? null,
      totalGapCount,
      gapRate: windowed.length === 0 ? null : totalGapCount / windowed.length,
    },
    missingness: {
      dueForecastCount: dueSet.size,
      evaluatedForecastCount: entries.length,
      missingOutcomeCount: Math.max(0, dueSet.size - entries.length),
    },
    news: {
      available: false,
      unavailableReason: 'news_scores_not_persisted',
      evidenceCount: storedNewsEvidenceCount,
    },
    segments: {
      all: {
        ...segmentFor('all', entries, windowed.length),
        evaluatedOutcomeCount: entries.length,
      },
      perRegime,
      perHorizon,
    },
    comparative: buildComparative(entries, asOfTimestamp),
  }
}

export function shadowAggregationFor({
  run,
  inputs,
}: ShadowAggregationCycle): ShadowMetrics {
  if (run.versions.aggregationRuleVersion !== SHADOW_AGGREGATION_RULE_VERSION)
    throw new Error(
      `Unsupported aggregation rule ${run.versions.aggregationRuleVersion} for shadow aggregation.`,
    )
  return buildShadowMetrics(
    inputs.forecasts,
    inputs.outcomes,
    inputs.asOfTimestamp,
    inputs.storedNewsEvidenceCount,
  )
}
