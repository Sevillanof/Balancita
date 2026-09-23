import { describe, expect, it } from 'vitest'
import {
  parseTimestampMs,
  type ForecastRecord,
} from '../../domain/contracts.ts'
import {
  validateForecastOutcome,
  validateForecastRecord,
} from './forecast-validation.ts'

const time = (value: number) => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

const validRecord: ForecastRecord = {
  id: 'forecast-1',
  version: '1',
  instrumentId: 'BTC-EUR',
  createdAt: time(2_000),
  asOfTimestamp: time(1_000),
  eventCutoff: time(1_000),
  horizon: '1h',
  referencePrice: 60_000,
  probabilityUp: 0.6,
  probabilityDown: 0.2,
  probabilityFlat: 0.2,
  expectedRange: { lower: 59_000, upper: 61_000 },
  expectedReturn: 0.01,
  technicalFeatureSnapshot: {
    version: 'technical-v1',
    asOfTimestamp: time(900),
    isClosed: true,
    ready: true,
    warmUp: { requiredCandles: 20, availableCandles: 20, missingCandles: 0 },
    values: { rsi: 55 },
  },
  newsEvidenceReferences: [
    {
      id: 'news-1',
      version: '2',
      publishedAt: time(700),
      ingestedAt: time(800),
      contentHash: 'sha256:news',
    },
  ],
  dataFreshness: { ageMs: 100, isStale: false, clockInverted: false },
  dataGaps: {
    gapCount: 0,
    expectedOpportunities: 10,
    rate: 0,
    sequenceAvailable: true,
  },
  modelVersion: 'baseline-v1',
  ruleVersion: 'rules-v1',
  sourceMode: 'shadow_live',
  replayRunId: null,
  abstained: false,
  contentHash: 'sha256:forecast',
}

describe('forecast contracts', () => {
  it('accepts a complete immutable forecast record', () => {
    expect(validateForecastRecord(validRecord)).toEqual({
      valid: true,
      value: validRecord,
    })
  })

  it('requires probabilities in range and equal to one within explicit tolerance', () => {
    expect(
      validateForecastRecord({
        ...validRecord,
        probabilityFlat: 0.2000000005,
      }),
    ).toMatchObject({ valid: true })
    const invalid = validateForecastRecord({
      ...validRecord,
      probabilityUp: 0.7,
      probabilityDown: 0.2,
      probabilityFlat: 0.2,
    })
    expect(invalid.valid).toBe(false)
    if (!invalid.valid)
      expect(invalid.issues.map((issue) => issue.code)).toContain(
        'probabilities_sum',
      )
  })

  it('rejects look-ahead evidence, open candles, and unsupported horizons', () => {
    const invalid = validateForecastRecord({
      ...validRecord,
      horizon: '2h',
      technicalFeatureSnapshot: {
        ...validRecord.technicalFeatureSnapshot,
        asOfTimestamp: time(1_001),
        isClosed: false,
      },
      newsEvidenceReferences: [
        {
          ...validRecord.newsEvidenceReferences[0],
          ingestedAt: time(1_001),
        },
      ],
    })
    expect(invalid.valid).toBe(false)
    if (!invalid.valid) {
      expect(invalid.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'invalid_horizon',
          'feature_after_cutoff',
          'open_candle_evidence',
          'news_after_cutoff',
        ]),
      )
    }
  })

  it('requires a reason for abstention and complete feature/news versions', () => {
    const invalid = validateForecastRecord({
      ...validRecord,
      abstained: true,
      technicalFeatureSnapshot: {
        ...validRecord.technicalFeatureSnapshot,
        version: '',
      },
      newsEvidenceReferences: [
        { ...validRecord.newsEvidenceReferences[0], version: '' },
      ],
    })
    expect(invalid.valid).toBe(false)
    if (!invalid.valid) {
      expect(invalid.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'abstention_reason_required',
          'feature_version_required',
          'news_version_required',
        ]),
      )
    }
  })

  it('validates append-only outcomes against the referenced forecast', () => {
    const outcome = {
      id: 'outcome-1',
      version: '1',
      forecastId: validRecord.id,
      forecastVersion: validRecord.version,
      evaluatedAt: time(5_600),
      observedEventTime: time(5_600),
      observedDataHash: 'sha256:observed',
      observedDataIsClosed: true,
      observedPrice: 60_500,
      label: 'up',
      realizedReturn: 0.0083,
      neutralBand: 0.0015,
      brierScore: 0.24,
      contentHash: 'sha256:outcome',
    }
    expect(validateForecastOutcome(outcome, validRecord)).toMatchObject({
      valid: true,
    })
    expect(
      validateForecastOutcome(
        { ...outcome, forecastVersion: '2', evaluatedAt: time(999) },
        validRecord,
      ),
    ).toMatchObject({ valid: false })
  })
})
