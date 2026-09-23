import {
  type ForecastCostParameters,
  type ForecastOutcome,
  type ForecastRecord,
  type TimestampMs,
} from '../../domain/contracts.ts'
import { contentHashFor } from './forecast-hashing.ts'

export const HORIZON_MS: Readonly<Record<ForecastRecord['horizon'], number>> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
}

export const DEFAULT_NEUTRAL_BAND = 0.0015
const LOG_LOSS_EPSILON = 1e-15

export interface ObservedPriceEvidence {
  readonly now: TimestampMs
  readonly eventTime: TimestampMs
  readonly price: number
  readonly contentHash: string
  readonly isClosed: boolean
  readonly costs?: ForecastCostParameters
}

export class ForecastEvaluationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForecastEvaluationError'
  }
}

export function evaluateForecast(
  forecast: ForecastRecord,
  observed: ObservedPriceEvidence,
  neutralBand = DEFAULT_NEUTRAL_BAND,
): ForecastOutcome {
  if (!Number.isFinite(neutralBand) || neutralBand < 0)
    throw new ForecastEvaluationError(
      'Neutral band must be finite and non-negative.',
    )
  const dueAt = forecast.asOfTimestamp + HORIZON_MS[forecast.horizon]
  if (observed.now < dueAt)
    throw new ForecastEvaluationError('Forecast horizon has not elapsed.')
  if (observed.eventTime < dueAt || observed.eventTime < forecast.eventCutoff)
    throw new ForecastEvaluationError(
      'Observed event time is before the valid horizon.',
    )
  if (!observed.isClosed)
    throw new ForecastEvaluationError('Open observed data is not valid.')
  if (!Number.isFinite(observed.price) || observed.price <= 0)
    throw new ForecastEvaluationError(
      'Observed price must be finite and positive.',
    )
  if (observed.contentHash.trim().length === 0)
    throw new ForecastEvaluationError('Observed data hash is required.')

  const grossReturn = observed.price / forecast.referencePrice - 1
  const realizedReturn = grossReturn - costRate(observed.costs)
  const comparableReturn = Number(realizedReturn.toFixed(12))
  const label =
    comparableReturn > neutralBand
      ? 'up'
      : comparableReturn < -neutralBand
        ? 'down'
        : 'flat'
  const withoutHash: Omit<ForecastOutcome, 'contentHash'> = {
    id: `${forecast.id}:${forecast.version}:${observed.contentHash}`,
    version: '1',
    forecastId: forecast.id,
    forecastVersion: forecast.version,
    evaluatedAt: observed.eventTime,
    observedEventTime: observed.eventTime,
    observedDataHash: observed.contentHash,
    observedDataIsClosed: true,
    observedPrice: observed.price,
    label,
    realizedReturn,
    neutralBand,
    ...(observed.costs === undefined ? {} : { costs: observed.costs }),
    brierScore: brierScore(forecast, label),
    logLoss: logLoss(forecast, label),
    ...(forecast.expectedReturn === undefined
      ? {}
      : {
          returnAbsoluteError: Math.abs(
            realizedReturn - forecast.expectedReturn,
          ),
        }),
    ...(forecast.expectedRange === undefined
      ? {}
      : {
          rangeAbsoluteError: rangeError(
            observed.price,
            forecast.expectedRange,
          ),
        }),
  }
  return { ...withoutHash, contentHash: contentHashFor(withoutHash) }
}

function costRate(costs: ForecastCostParameters | undefined): number {
  if (costs === undefined) return 0
  if (
    !Number.isFinite(costs.commissionRate) ||
    !Number.isFinite(costs.slippageRate) ||
    costs.commissionRate < 0 ||
    costs.slippageRate < 0 ||
    costs.version.trim().length === 0
  )
    throw new ForecastEvaluationError(
      'Versioned costs must be finite and non-negative.',
    )
  return costs.commissionRate + costs.slippageRate
}

function brierScore(
  forecast: ForecastRecord,
  label: ForecastOutcome['label'],
): number {
  const target =
    label === 'up' ? [1, 0, 0] : label === 'down' ? [0, 1, 0] : [0, 0, 1]
  return (
    (forecast.probabilityUp - target[0]) ** 2 +
    (forecast.probabilityDown - target[1]) ** 2 +
    (forecast.probabilityFlat - target[2]) ** 2
  )
}

function logLoss(
  forecast: ForecastRecord,
  label: ForecastOutcome['label'],
): number {
  const probability =
    label === 'up'
      ? forecast.probabilityUp
      : label === 'down'
        ? forecast.probabilityDown
        : forecast.probabilityFlat
  return -Math.log(Math.max(probability, LOG_LOSS_EPSILON))
}

function rangeError(
  price: number,
  range: { readonly lower: number; readonly upper: number },
): number {
  if (price < range.lower) return range.lower - price
  if (price > range.upper) return price - range.upper
  return 0
}
