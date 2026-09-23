import { describe, expect, it } from 'vitest'
import { parseTimestampMs, type TimestampMs } from '../../domain/contracts.ts'
import { generateForecast } from './forecast-engine.ts'
import {
  ForecastEvaluationError,
  evaluateForecast,
  HORIZON_MS,
  type ObservedPriceEvidence,
} from './forecast-evaluator.ts'

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

const forecast = generateForecast({
  id: 'forecast-1',
  version: '1',
  createdAt: time(1_000),
  asOfTimestamp: time(1_000),
  eventCutoff: time(1_000),
  horizon: '1h',
  referencePrice: 100,
  candles: [
    {
      eventTimeEnd: time(900),
      bucketEnd: time(1_000),
      close: 100,
      isClosed: true,
      status: 'live',
    },
  ],
  technicalFeatureSnapshot: {
    version: 'technical-features.v1',
    asOfTimestamp: time(900),
    isClosed: true,
    ready: true,
    warmUp: { requiredCandles: 1, availableCandles: 1, missingCandles: 0 },
    values: { sma: 99, rsi: 60, macdHistogram: 1, structuralSlope: 1 },
  },
  dataFreshness: { ageMs: 0, isStale: false, clockInverted: false },
  dataGaps: {
    gapCount: 0,
    expectedOpportunities: 1,
    rate: 0,
    sequenceAvailable: true,
  },
  newsEvidenceReferences: [],
})

const evidence = (
  overrides: Partial<ObservedPriceEvidence> = {},
): ObservedPriceEvidence => ({
  now: time(1_000 + HORIZON_MS['1h']),
  eventTime: time(1_000 + HORIZON_MS['1h']),
  price: 101,
  contentHash: 'observed-1',
  isClosed: true,
  ...overrides,
})

describe('deferred forecast evaluator', () => {
  it('rejects evaluation before the horizon and accepts the exact boundary', () => {
    expect(() =>
      evaluateForecast(forecast, evidence({ now: time(3_599_999) })),
    ).toThrow(ForecastEvaluationError)
    const outcome = evaluateForecast(forecast, evidence())
    expect(outcome.evaluatedAt).toBe(3_601_000)
    expect(outcome.label).toBe('up')
  })

  it('rejects early, open, and future-invalid observed evidence', () => {
    expect(() =>
      evaluateForecast(forecast, evidence({ eventTime: time(3_599_999) })),
    ).toThrow(ForecastEvaluationError)
    expect(() =>
      evaluateForecast(forecast, evidence({ isClosed: false })),
    ).toThrow(ForecastEvaluationError)
  })

  it('uses exact neutral-band boundaries and versioned costs', () => {
    const flat = evaluateForecast(
      forecast,
      evidence({
        price: 100.15,
        contentHash: 'observed-flat',
        costs: { version: 'costs.v1', commissionRate: 0, slippageRate: 0 },
      }),
    )
    const netDown = evaluateForecast(
      forecast,
      evidence({
        price: 100.2,
        contentHash: 'observed-cost',
        costs: {
          version: 'costs.v1',
          commissionRate: 0.001,
          slippageRate: 0.001,
        },
      }),
    )

    expect(flat.label).toBe('flat')
    expect(
      evaluateForecast(
        forecast,
        evidence({ price: 99.85, contentHash: 'observed-flat-lower' }),
      ).label,
    ).toBe('flat')
    expect(
      evaluateForecast(
        forecast,
        evidence({ price: 99.84, contentHash: 'observed-down' }),
      ).label,
    ).toBe('down')
    expect(netDown.realizedReturn).toBeCloseTo(0, 12)
    expect(netDown.label).toBe('flat')
    expect(netDown.costs).toEqual({
      version: 'costs.v1',
      commissionRate: 0.001,
      slippageRate: 0.001,
    })
  })
})
