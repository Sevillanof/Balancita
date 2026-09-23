import { describe, expect, it } from 'vitest'
import type { ForecastMetricEntry } from './forecast-metrics.ts'
import {
  calculateBrierScore,
  calculateCalibrationByBand,
  calculateCoverage,
  calculateDirectionalAccuracy,
  calculateLogLoss,
  calculateMeanAbsoluteError,
  calculateRangeMae,
  calculateReturnMae,
  segmentForecastMetrics,
  type CalibrationBandDefinition,
} from './forecast-metrics.ts'

const entry = (
  probabilityUp: number,
  label: 'up' | 'down' | 'flat',
  realizedReturn = 0.01,
): ForecastMetricEntry => ({
  forecast: {
    probabilityUp,
    probabilityDown: (1 - probabilityUp) / 2,
    probabilityFlat: (1 - probabilityUp) / 2,
    abstained: false,
    horizon: '1h',
  },
  outcome: { label, realizedReturn },
})

describe('forecast metrics', () => {
  it('calculates known Brier, directional accuracy, and guarded log loss values', () => {
    const entries = [entry(0.8, 'up'), entry(0.2, 'down')]

    expect(calculateBrierScore(entries)).toBeCloseTo(0.31, 12)
    expect(calculateDirectionalAccuracy(entries)).toBe(1)
    expect(calculateLogLoss(entries)).toBeCloseTo(
      (-Math.log(0.8) - Math.log(0.4)) / 2,
      12,
    )
    expect(calculateLogLoss([entry(0, 'up')])).toBeGreaterThan(0)
  })

  it('calculates coverage, calibration bands, and MAE without claiming performance', () => {
    const entries = [
      entry(0.8, 'up', 0.1),
      entry(0.6, 'down', -0.05),
      {
        ...entry(0.9, 'flat'),
        forecast: { ...entry(0.9, 'flat').forecast, abstained: true },
      },
    ]
    const bands: readonly CalibrationBandDefinition[] = [
      { lowerInclusive: 0.5, upperExclusive: 0.8 },
      { lowerInclusive: 0.8, upperExclusive: 1.01 },
    ]

    expect(calculateCoverage(entries)).toEqual({
      total: 3,
      issued: 2,
      abstained: 1,
      coverage: 2 / 3,
      abstentionRate: 1 / 3,
    })
    expect(calculateCalibrationByBand(entries, bands)).toEqual([
      {
        ...bands[0],
        count: 1,
        meanPredictedProbability: 0.6,
        observedFrequency: 0,
      },
      {
        ...bands[1],
        count: 1,
        meanPredictedProbability: 0.8,
        observedFrequency: 1,
      },
    ])
    expect(calculateMeanAbsoluteError([0.1, -0.05], [0, -0.1])).toBeCloseTo(
      0.075,
      12,
    )
    expect(
      calculateReturnMae([
        {
          ...entry(0.8, 'up', 0.1),
          forecast: { ...entry(0.8, 'up').forecast, expectedReturn: 0.08 },
        },
      ]),
    ).toBeCloseTo(0.02, 12)
    expect(
      calculateRangeMae([
        {
          ...entry(0.8, 'up'),
          forecast: {
            ...entry(0.8, 'up').forecast,
            expectedRange: { lower: 90, upper: 100 },
          },
          outcome: { label: 'up', realizedReturn: 0.1, observedPrice: 102 },
        },
      ]),
    ).toBe(2)
    expect(
      segmentForecastMetrics([
        {
          ...entry(0.8, 'up'),
          forecast: { ...entry(0.8, 'up').forecast, regime: 'high' },
        },
      ]),
    ).toMatchObject([{ key: '1h:high', horizon: '1h', regime: 'high' }])
  })

  it('rejects invalid probabilities and returns null for empty aggregates', () => {
    expect(calculateBrierScore([])).toBeNull()
    expect(calculateMeanAbsoluteError([], [])).toBeNull()
    expect(() => calculateBrierScore([entry(Number.NaN, 'up')])).toThrow()
  })
})
