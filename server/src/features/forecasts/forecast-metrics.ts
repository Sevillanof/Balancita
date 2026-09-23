import type { ForecastHorizon } from '../../domain/contracts.ts'

const PROBABILITY_TOLERANCE = 1e-9

export interface ForecastMetricEntry {
  readonly forecast: {
    readonly probabilityUp: number
    readonly probabilityDown: number
    readonly probabilityFlat: number
    readonly abstained: boolean
    readonly horizon: ForecastHorizon
    readonly regime?: string
    readonly expectedReturn?: number
    readonly expectedRange?: { readonly lower: number; readonly upper: number }
  }
  readonly outcome: {
    readonly label: 'up' | 'down' | 'flat'
    readonly realizedReturn: number
    readonly observedPrice?: number
  }
}

export interface CoverageMetrics {
  readonly total: number
  readonly issued: number
  readonly abstained: number
  readonly coverage: number | null
  readonly abstentionRate: number | null
}

export interface CalibrationBandDefinition {
  readonly lowerInclusive: number
  readonly upperExclusive: number
}

export interface CalibrationBand extends CalibrationBandDefinition {
  readonly count: number
  readonly meanPredictedProbability: number | null
  readonly observedFrequency: number | null
}

export interface ForecastMetricSegment {
  readonly key: string
  readonly horizon: ForecastHorizon
  readonly regime?: string
  readonly entries: readonly ForecastMetricEntry[]
}

export function calculateCoverage(
  entries: readonly ForecastMetricEntry[],
): CoverageMetrics {
  const issued = entries.filter((entry) => !entry.forecast.abstained).length
  const abstained = entries.length - issued
  return {
    total: entries.length,
    issued,
    abstained,
    coverage: entries.length === 0 ? null : issued / entries.length,
    abstentionRate: entries.length === 0 ? null : abstained / entries.length,
  }
}

export function calculateDirectionalAccuracy(
  entries: readonly ForecastMetricEntry[],
): number | null {
  const issued = issuedEntries(entries)
  if (issued.length === 0) return null
  const correct = issued.filter(
    (entry) => predictedLabel(entry) === entry.outcome.label,
  ).length
  return correct / issued.length
}

export function calculateBrierScore(
  entries: readonly ForecastMetricEntry[],
): number | null {
  const issued = issuedEntries(entries)
  if (issued.length === 0) return null
  return mean(
    issued.map((entry) => {
      validateProbabilities(entry)
      const target = oneHot(entry.outcome.label)
      return (
        (entry.forecast.probabilityUp - target[0]) ** 2 +
        (entry.forecast.probabilityDown - target[1]) ** 2 +
        (entry.forecast.probabilityFlat - target[2]) ** 2
      )
    }),
  )
}

export function calculateLogLoss(
  entries: readonly ForecastMetricEntry[],
): number | null {
  const issued = issuedEntries(entries)
  if (issued.length === 0) return null
  return mean(
    issued.map((entry) => {
      validateProbabilities(entry)
      const target = oneHot(entry.outcome.label)
      const probability =
        target[0] === 1
          ? entry.forecast.probabilityUp
          : target[1] === 1
            ? entry.forecast.probabilityDown
            : entry.forecast.probabilityFlat
      return -Math.log(Math.max(probability, Number.MIN_VALUE))
    }),
  )
}

export function calculateCalibrationByBand(
  entries: readonly ForecastMetricEntry[],
  definitions: readonly CalibrationBandDefinition[],
): readonly CalibrationBand[] {
  return definitions.map((definition, index) => {
    if (
      !Number.isFinite(definition.lowerInclusive) ||
      !Number.isFinite(definition.upperExclusive) ||
      definition.lowerInclusive < 0 ||
      definition.upperExclusive <= definition.lowerInclusive ||
      (index === definitions.length - 1 && definition.upperExclusive < 1)
    )
      throw new Error(
        'Calibration bands must be ordered finite probability ranges.',
      )
    const selected = issuedEntries(entries).filter((entry) => {
      if (entry.forecast.abstained) return false
      validateProbabilities(entry)
      const confidence = Math.max(
        entry.forecast.probabilityUp,
        entry.forecast.probabilityDown,
        entry.forecast.probabilityFlat,
      )
      return (
        confidence >= definition.lowerInclusive &&
        confidence < definition.upperExclusive
      )
    })
    return {
      ...definition,
      count: selected.length,
      meanPredictedProbability:
        selected.length === 0 ? null : mean(selected.map(maxProbability)),
      observedFrequency:
        selected.length === 0
          ? null
          : selected.filter(
              (entry) => predictedLabel(entry) === entry.outcome.label,
            ).length / selected.length,
    }
  })
}

export function calculateMeanAbsoluteError(
  actual: readonly number[],
  expected: readonly number[],
): number | null {
  if (actual.length !== expected.length)
    throw new Error('MAE inputs must have equal lengths.')
  if (actual.length === 0) return null
  actual.forEach((value) => {
    if (!Number.isFinite(value)) throw new Error('MAE values must be finite.')
  })
  expected.forEach((value) => {
    if (!Number.isFinite(value)) throw new Error('MAE values must be finite.')
  })
  return mean(actual.map((value, index) => Math.abs(value - expected[index]!)))
}

export function calculateReturnMae(
  entries: readonly ForecastMetricEntry[],
): number | null {
  const selected = issuedEntries(entries).filter(
    (
      entry,
    ): entry is ForecastMetricEntry & {
      readonly forecast: ForecastMetricEntry['forecast'] & {
        readonly expectedReturn: number
      }
    } => entry.forecast.expectedReturn !== undefined,
  )
  return calculateMeanAbsoluteError(
    selected.map((entry) => entry.outcome.realizedReturn),
    selected.map((entry) => entry.forecast.expectedReturn),
  )
}

export function calculateRangeMae(
  entries: readonly ForecastMetricEntry[],
): number | null {
  const selected = issuedEntries(entries).filter(
    (entry) =>
      entry.forecast.expectedRange !== undefined &&
      entry.outcome.observedPrice !== undefined,
  )
  if (selected.length === 0) return null
  return mean(
    selected.map((entry) => {
      const range = entry.forecast.expectedRange!
      const price = entry.outcome.observedPrice!
      if (price < range.lower) return range.lower - price
      if (price > range.upper) return price - range.upper
      return 0
    }),
  )
}

export function segmentForecastMetrics(
  entries: readonly ForecastMetricEntry[],
): readonly ForecastMetricSegment[] {
  const segments = new Map<string, ForecastMetricSegment>()
  for (const entry of entries) {
    const key = `${entry.forecast.horizon}:${entry.forecast.regime ?? 'unspecified'}`
    const existing = segments.get(key)
    if (existing === undefined) {
      segments.set(key, {
        key,
        horizon: entry.forecast.horizon,
        ...(entry.forecast.regime === undefined
          ? {}
          : { regime: entry.forecast.regime }),
        entries: [entry],
      })
    } else {
      segments.set(key, { ...existing, entries: [...existing.entries, entry] })
    }
  }
  return [...segments.values()]
}

function issuedEntries(
  entries: readonly ForecastMetricEntry[],
): readonly ForecastMetricEntry[] {
  return entries.filter((entry) => !entry.forecast.abstained)
}

function predictedLabel(
  entry: ForecastMetricEntry,
): ForecastMetricEntry['outcome']['label'] {
  const probabilities = [
    entry.forecast.probabilityUp,
    entry.forecast.probabilityDown,
    entry.forecast.probabilityFlat,
  ]
  validateProbabilities(entry)
  const max = Math.max(...probabilities)
  if (probabilities[0] === max) return 'up'
  if (probabilities[1] === max) return 'down'
  return 'flat'
}

function maxProbability(entry: ForecastMetricEntry): number {
  return Math.max(
    entry.forecast.probabilityUp,
    entry.forecast.probabilityDown,
    entry.forecast.probabilityFlat,
  )
}

function validateProbabilities(entry: ForecastMetricEntry): void {
  const probabilities = [
    entry.forecast.probabilityUp,
    entry.forecast.probabilityDown,
    entry.forecast.probabilityFlat,
  ]
  if (
    probabilities.some(
      (probability) =>
        !Number.isFinite(probability) || probability < 0 || probability > 1,
    ) ||
    Math.abs(
      probabilities.reduce((sum, probability) => sum + probability, 0) - 1,
    ) > PROBABILITY_TOLERANCE
  )
    throw new Error(
      'Forecast probabilities must be finite, bounded, and sum to one.',
    )
}

function oneHot(
  label: ForecastMetricEntry['outcome']['label'],
): readonly [number, number, number] {
  return label === 'up' ? [1, 0, 0] : label === 'down' ? [0, 1, 0] : [0, 0, 1]
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
