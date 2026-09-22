import type { ForecastOutcome, ForecastRecord } from '../contracts.ts'
import {
  calculateBrierScore,
  calculateCalibrationByBand,
  calculateCoverage,
  calculateReturnMae,
  type CalibrationBand,
  type CalibrationBandDefinition,
  type ForecastMetricEntry,
} from '../forecast-metrics.ts'

/**
 * Fixed confidence bands for replay summaries. The last band extends past 1
 * so a forecast with maximum confidence 1.0 is still counted (repo
 * convention, see forecast-metrics tests).
 */
export const REPLAY_CALIBRATION_BANDS: readonly CalibrationBandDefinition[] = [
  { lowerInclusive: 1 / 3, upperExclusive: 0.5 },
  { lowerInclusive: 0.5, upperExclusive: 0.7 },
  { lowerInclusive: 0.7, upperExclusive: 0.9 },
  { lowerInclusive: 0.9, upperExclusive: 1.01 },
]

export interface ReplayMetricsSummary {
  readonly counts: {
    readonly forecasts: number
    readonly outcomes: number
    /** Forecasts successfully joined to an outcome. */
    readonly evaluated: number
  }
  readonly coverage: number | null
  readonly abstention: number | null
  readonly brier: number | null
  readonly calibrationBands: readonly CalibrationBand[]
  readonly returnMae: number | null
}

/**
 * Join forecasts to outcomes by forecast id/version. Forecasts past the
 * dataset end have no outcome (their horizon never elapsed inside the data);
 * they are counted but excluded from the metric entries.
 */
export function toMetricEntries(
  forecasts: readonly ForecastRecord[],
  outcomes: readonly ForecastOutcome[],
): ForecastMetricEntry[] {
  const byForecast = new Map(
    forecasts.map((forecast) => [
      `${forecast.id}:${forecast.version}`,
      forecast,
    ]),
  )
  const entries: ForecastMetricEntry[] = []
  for (const outcome of outcomes) {
    const forecast = byForecast.get(
      `${outcome.forecastId}:${outcome.forecastVersion}`,
    )
    if (forecast === undefined) continue
    entries.push({
      forecast: {
        probabilityUp: forecast.probabilityUp,
        probabilityDown: forecast.probabilityDown,
        probabilityFlat: forecast.probabilityFlat,
        abstained: forecast.abstained,
        horizon: forecast.horizon,
        ...(forecast.expectedReturn === undefined
          ? {}
          : { expectedReturn: forecast.expectedReturn }),
      },
      outcome: {
        label: outcome.label,
        realizedReturn: outcome.realizedReturn,
        observedPrice: outcome.observedPrice,
      },
    })
  }
  return entries
}

/**
 * Pure summary of one replay run. It reads only the forecasts/outcomes it is
 * given and never touches the versioned ReplayReport schema.
 */
export function summarizeReplayRun(input: {
  readonly forecasts: readonly ForecastRecord[]
  readonly outcomes: readonly ForecastOutcome[]
}): ReplayMetricsSummary {
  const entries = toMetricEntries(input.forecasts, input.outcomes)
  const coverage = calculateCoverage(entries)
  return {
    counts: {
      forecasts: input.forecasts.length,
      outcomes: input.outcomes.length,
      evaluated: entries.length,
    },
    coverage: coverage.coverage,
    abstention: coverage.abstentionRate,
    brier: calculateBrierScore(entries),
    calibrationBands: calculateCalibrationByBand(
      entries,
      REPLAY_CALIBRATION_BANDS,
    ),
    returnMae: calculateReturnMae(entries),
  }
}
