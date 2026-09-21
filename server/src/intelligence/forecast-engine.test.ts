import { describe, expect, it } from 'vitest'
import { parseTimestampMs, type TimestampMs } from './contracts.ts'
import {
  FORECAST_MODEL_VERSION,
  FORECAST_RULE_VERSION,
  generateForecast,
  type ForecastCandleEvidence,
  type ForecastEngineInput,
} from './forecast-engine.ts'

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

const candle = (
  overrides: Partial<ForecastCandleEvidence> = {},
): ForecastCandleEvidence => ({
  eventTimeEnd: time(900),
  bucketEnd: time(1_000),
  close: 101,
  isClosed: true,
  status: 'live',
  ...overrides,
})

const baseInput = (): ForecastEngineInput => ({
  id: 'forecast-1',
  version: '1',
  createdAt: time(1_100),
  asOfTimestamp: time(1_000),
  eventCutoff: time(1_000),
  horizon: '1h',
  referencePrice: 101,
  candles: [
    candle(),
    candle({ eventTimeEnd: time(1_001), bucketEnd: time(2_000) }),
    candle({ isClosed: false, bucketEnd: time(1_000) }),
  ],
  technicalFeatureSnapshot: {
    version: 'technical-features.v1',
    asOfTimestamp: time(900),
    isClosed: true,
    ready: true,
    warmUp: { requiredCandles: 20, availableCandles: 20, missingCandles: 0 },
    values: {
      sma: 100,
      rsi: 60,
      macdHistogram: 1,
      structuralSlope: 1,
    },
  },
  dataFreshness: { ageMs: 100, isStale: false, clockInverted: false },
  dataGaps: {
    gapCount: 0,
    expectedOpportunities: 1,
    rate: 0,
    sequenceAvailable: true,
  },
  newsEvidenceReferences: [],
})

describe('forecast engine', () => {
  it('emits finite probabilities that sum to one and repeats exactly', () => {
    const input = baseInput()
    const first = generateForecast(input)
    const second = generateForecast(input)

    expect(first).toEqual(second)
    expect(first.modelVersion).toBe(FORECAST_MODEL_VERSION)
    expect(first.ruleVersion).toBe(FORECAST_RULE_VERSION)
    expect(first.abstained).toBe(false)
    expect(
      first.probabilityUp + first.probabilityDown + first.probabilityFlat,
    ).toBeCloseTo(1, 12)
    expect(
      [first.probabilityUp, first.probabilityDown, first.probabilityFlat].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      ),
    ).toBe(true)
  })

  it.each([
    [
      'warmup',
      (input: ForecastEngineInput) => ({
        ...input,
        technicalFeatureSnapshot: {
          ...input.technicalFeatureSnapshot,
          ready: false,
          warmUp: {
            requiredCandles: 20,
            availableCandles: 10,
            missingCandles: 10,
          },
        },
      }),
    ],
    [
      'stale',
      (input: ForecastEngineInput) => ({
        ...input,
        dataFreshness: { ageMs: 10_000, isStale: true, clockInverted: false },
      }),
    ],
    [
      'gaps',
      (input: ForecastEngineInput) => ({
        ...input,
        dataGaps: { ...input.dataGaps, gapCount: 1, rate: 0.1 },
      }),
    ],
    [
      'unreliable features',
      (input: ForecastEngineInput) => ({
        ...input,
        technicalFeatureSnapshot: {
          ...input.technicalFeatureSnapshot,
          values: { sma: 100 },
        },
      }),
    ],
  ])('abstains for %s evidence quality failures', (_reason, mutate) => {
    const forecast = generateForecast(mutate(baseInput()))

    expect(forecast.abstained).toBe(true)
    expect(forecast.abstentionReason).toBeTruthy()
    expect(forecast.probabilityUp).toBe(1 / 3)
    expect(forecast.probabilityDown).toBe(1 / 3)
    expect(forecast.probabilityFlat).toBe(1 / 3)
  })

  it('excludes open and future candles and future news from the cutoff', () => {
    const eligible = generateForecast(baseInput())
    const noClosedCandle = generateForecast({
      ...baseInput(),
      candles: baseInput().candles.slice(1),
    })
    const futureNews = generateForecast({
      ...baseInput(),
      newsEvidenceReferences: [
        {
          id: 'news-future',
          version: '1',
          publishedAt: time(1_001),
          ingestedAt: time(1_001),
          contentHash: 'news-hash',
        },
      ],
    })

    expect(eligible.abstained).toBe(false)
    expect(noClosedCandle.abstentionReason).toBe('missing_closed_candle')
    expect(futureNews.abstained).toBe(true)
    expect(futureNews.abstentionReason).toBe('future_news_evidence')
    expect(futureNews.newsEvidenceReferences).toEqual([])
  })
})
