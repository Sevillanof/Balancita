import { describe, expect, it } from 'vitest'
import type {
  ForecastOutcome,
  ForecastRecord,
  TimestampMs,
} from '../contracts.ts'
import {
  summarizeReplayRun,
  toMetricEntries,
} from './replay-metrics-summary.ts'

function forecast(overrides: Partial<ForecastRecord> = {}): ForecastRecord {
  return {
    id: 'forecast-1',
    version: '1',
    instrumentId: 'BTC-EUR',
    createdAt: 1_000 as TimestampMs,
    asOfTimestamp: 1_000 as TimestampMs,
    eventCutoff: 1_000 as TimestampMs,
    horizon: '15m',
    referencePrice: 60_000,
    probabilityUp: 0.7,
    probabilityDown: 0.2,
    probabilityFlat: 0.1,
    technicalFeatureSnapshot: {
      version: 'v1',
      asOfTimestamp: 1_000 as TimestampMs,
      isClosed: true,
      ready: true,
      warmUp: { requiredCandles: 10, availableCandles: 10, missingCandles: 0 },
      values: {},
    },
    newsEvidenceReferences: [],
    dataFreshness: { ageMs: 0, isStale: false, clockInverted: false },
    dataGaps: {
      gapCount: 0,
      expectedOpportunities: 1,
      rate: 0,
      sequenceAvailable: true,
    },
    modelVersion: 'm1',
    ruleVersion: 'r1',
    sourceMode: 'historical_replay',
    replayRunId: 'run-1',
    abstained: false,
    contentHash: 'hash-1',
    ...overrides,
  }
}

function outcome(overrides: Partial<ForecastOutcome> = {}): ForecastOutcome {
  return {
    id: 'outcome-1',
    version: '1',
    forecastId: 'forecast-1',
    forecastVersion: '1',
    evaluatedAt: 2_000 as TimestampMs,
    observedEventTime: 2_000 as TimestampMs,
    observedDataHash: 'data-hash',
    observedDataIsClosed: true,
    observedPrice: 60_100,
    label: 'up',
    realizedReturn: 0.01,
    neutralBand: 0.0015,
    brierScore: 0.14,
    contentHash: 'outcome-hash-1',
    ...overrides,
  }
}

describe('replay metrics summary', () => {
  it('computes coverage, brier, calibration, and return MAE on fixtures', () => {
    const forecasts = [
      forecast({
        id: 'a',
        contentHash: 'hash-a',
        probabilityUp: 0.7,
        probabilityDown: 0.2,
        probabilityFlat: 0.1,
        expectedReturn: 0.008,
      }),
      forecast({
        id: 'b',
        contentHash: 'hash-b',
        probabilityUp: 0.2,
        probabilityDown: 0.6,
        probabilityFlat: 0.2,
        expectedReturn: -0.004,
      }),
      forecast({ id: 'c', contentHash: 'hash-c', abstained: true }),
    ]
    const outcomes = [
      outcome({ id: 'oa', forecastId: 'a', label: 'up', realizedReturn: 0.01 }),
      outcome({
        id: 'ob',
        forecastId: 'b',
        label: 'down',
        realizedReturn: -0.005,
      }),
      outcome({
        id: 'oc',
        forecastId: 'c',
        label: 'flat',
        realizedReturn: 0.0,
      }),
    ]

    expect(toMetricEntries(forecasts, outcomes)).toHaveLength(3)
    const summary = summarizeReplayRun({ forecasts, outcomes })

    expect(summary.counts).toEqual({ forecasts: 3, outcomes: 3, evaluated: 3 })
    expect(summary.coverage).toBeCloseTo(2 / 3, 12)
    expect(summary.abstention).toBeCloseTo(1 / 3, 12)
    // A: (0.7-1)^2 + 0.2^2 + 0.1^2 = 0.14; B: 0.2^2 + (0.6-1)^2 + 0.2^2 = 0.24
    expect(summary.brier).toBeCloseTo(0.19, 12)
    // |0.01-0.008| + |-0.005+0.004| over 2 = 0.0015
    expect(summary.returnMae).toBeCloseTo(0.0015, 12)
    const band0709 = summary.calibrationBands.find(
      (band) => band.lowerInclusive === 0.7,
    )!
    expect(band0709).toMatchObject({
      count: 1,
      meanPredictedProbability: 0.7,
      observedFrequency: 1,
    })
    const band0507 = summary.calibrationBands.find(
      (band) => band.lowerInclusive === 0.5,
    )!
    expect(band0507).toMatchObject({
      count: 1,
      meanPredictedProbability: 0.6,
      observedFrequency: 1,
    })
  })

  it('counts forecasts without outcomes but excludes them from entries', () => {
    const forecasts = [
      forecast({ id: 'a', contentHash: 'hash-a' }),
      forecast({ id: 'tail', contentHash: 'hash-tail' }),
    ]
    const outcomes = [outcome({ id: 'oa', forecastId: 'a' })]

    const summary = summarizeReplayRun({ forecasts, outcomes })

    expect(summary.counts).toEqual({ forecasts: 2, outcomes: 1, evaluated: 1 })
    expect(summary.coverage).toBe(1)
  })

  it('returns nulls for empty runs', () => {
    const summary = summarizeReplayRun({ forecasts: [], outcomes: [] })

    expect(summary.counts).toEqual({ forecasts: 0, outcomes: 0, evaluated: 0 })
    expect(summary.coverage).toBeNull()
    expect(summary.abstention).toBeNull()
    expect(summary.brier).toBeNull()
    expect(summary.returnMae).toBeNull()
    expect(
      summary.calibrationBands.every(
        (band) =>
          band.count === 0 &&
          band.meanPredictedProbability === null &&
          band.observedFrequency === null,
      ),
    ).toBe(true)
  })
})
