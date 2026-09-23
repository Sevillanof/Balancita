import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { parseTimestampMs, type TimestampMs } from '../../domain/contracts.ts'
import {
  evaluateForecast,
  HORIZON_MS,
} from '../forecasts/forecast-evaluator.ts'
import { generateForecast } from '../forecasts/forecast-engine.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import { ForecastStoreValidationError, MarketStore } from './market-store.ts'

const directories: string[] = []

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-forecast-ledger-'))
  directories.push(directory)
  return join(directory, 'market.sqlite')
}

function makeForecast() {
  return generateForecast({
    id: 'forecast-ledger-1',
    version: '1',
    createdAt: time(1_100),
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
    dataFreshness: { ageMs: 100, isStale: false, clockInverted: false },
    dataGaps: {
      gapCount: 0,
      expectedOpportunities: 1,
      rate: 0,
      sequenceAvailable: true,
    },
    newsEvidenceReferences: [],
  })
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('forecast ledger', () => {
  it('persists immutable forecasts, duplicate replays, conflicts, and read-only queries', () => {
    const store = new MarketStore({ path: makePath() })
    const forecast = makeForecast()

    expect(store.insertForecast(forecast).outcome).toBe('inserted')
    expect(store.insertForecast(forecast).outcome).toBe('duplicate')
    expect(
      store.listForecasts({ horizon: '1h', createdAtFrom: time(1_000) }),
    ).toEqual([forecast])
    expect(() =>
      store.insertForecast({ ...forecast, probabilityUp: 0.51 }),
    ).toThrow(ForecastStoreValidationError)
    const changed = {
      ...forecast,
      probabilityUp: 0.54,
      probabilityDown: 0.21,
      contentHash: '',
    }
    const changedWithHash = {
      ...changed,
      contentHash: contentHashFor(changed),
    }
    expect(() => store.insertForecast(changedWithHash)).toThrow(
      ForecastStoreValidationError,
    )
    expect(store.forecastCount()).toBe(1)
    store.close()
  })

  it('adds outcomes only after the horizon and replays the same observed snapshot idempotently', () => {
    const store = new MarketStore({ path: makePath() })
    const forecast = makeForecast()
    store.insertForecast(forecast)
    const due = 1_000 + HORIZON_MS['1h']
    const outcome = evaluateForecast(forecast, {
      now: time(due),
      eventTime: time(due),
      price: 101,
      contentHash: 'observed-ledger-1',
      isClosed: true,
    })

    expect(store.insertOutcome(outcome).outcome).toBe('inserted')
    expect(store.insertOutcome(outcome).outcome).toBe('duplicate')
    expect(store.listOutcomes()).toEqual([outcome])
    expect(() =>
      store.insertOutcome({ ...outcome, observedPrice: 102 }),
    ).toThrow(ForecastStoreValidationError)
    store.close()
  })
})
