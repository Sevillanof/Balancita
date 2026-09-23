import { describe, expect, it } from 'vitest'
import type { ForecastRecord, TimestampMs } from '../../domain/contracts.ts'
import {
  generateForecast,
  type ForecastEngineInput,
} from './forecast-engine.ts'
import { INTERVAL_MS } from '../market-data/intraday-candles.ts'
import { KRAKEN_MARKET_SOURCE } from '../market-data/market-sources.ts'
import { MarketStore } from '../market-data/market-store.ts'
import { LiveForecastService } from './live-forecast.ts'

const START = Date.parse('2026-09-21T00:00:00.000Z') as TimestampMs
const INTERVAL = INTERVAL_MS['15m']

let nextTradeId = 1

function seedBucket(
  store: MarketStore,
  index: number,
  price: number,
  options: {
    qty?: number
    status?: 'live' | 'stale'
    source?: string
    instrumentId?: 'BTC-EUR'
  } = {},
): void {
  const eventTime = (START + index * INTERVAL + 1_000) as TimestampMs
  const tradeId = nextTradeId
  nextTradeId += 1
  store.insertObservation(
    {
      source: options.source ?? KRAKEN_MARKET_SOURCE,
      symbol: 'BTC-EUR',
      instrumentId: options.instrumentId ?? 'BTC-EUR',
      eventTime,
      receivedTime: eventTime,
      displayTime: eventTime,
      sequence: tradeId,
      payload: {
        type: 'trade',
        productId: 'BTC-EUR',
        tradeId,
        sequence: tradeId,
        price,
        qty: options.qty ?? 1,
        side: 'buy',
      },
      status: options.status ?? 'live',
      freshness: { ageMs: 0, isStale: false, clockInverted: false },
    },
    eventTime,
  )
}

function historicalForecast(
  id: string,
  asOf: TimestampMs,
  price: number,
): ForecastRecord {
  const input: ForecastEngineInput = {
    id,
    version: '1',
    createdAt: asOf,
    asOfTimestamp: asOf,
    eventCutoff: asOf,
    horizon: '15m',
    referencePrice: price,
    candles: [
      {
        eventTimeEnd: asOf,
        bucketEnd: asOf,
        close: price,
        isClosed: true,
        status: 'live',
      },
    ],
    technicalFeatureSnapshot: {
      version: 'technical-features.v1',
      asOfTimestamp: asOf,
      isClosed: true,
      ready: true,
      warmUp: { requiredCandles: 1, availableCandles: 1, missingCandles: 0 },
      values: { sma: price, rsi: 50, macdHistogram: 0, structuralSlope: 0 },
    },
    dataFreshness: { ageMs: 0, isStale: false, clockInverted: false },
    dataGaps: {
      gapCount: 0,
      expectedOpportunities: 1,
      rate: 0,
      sequenceAvailable: true,
    },
    newsEvidenceReferences: [],
    sourceMode: 'historical_replay',
    replayRunId: 'replay-run',
  }
  return generateForecast(input)
}

function makeService() {
  const store = new MarketStore({ path: ':memory:' })
  const service = new LiveForecastService({ store, instrumentId: 'BTC-EUR' })
  return { store, service }
}

describe('LiveForecastService', () => {
  it('persists one forecast for the latest closed candle and is idempotent', () => {
    const { store, service } = makeService()
    for (let index = 0; index < 35; index += 1)
      seedBucket(store, index, 100 + index)
    const now = (START + 35 * INTERVAL) as TimestampMs

    const first = service.runOnce(now)

    expect(first.outcome).toBe('generated')
    const forecastId = `shadow:BTC-EUR:${now}`
    expect(first.forecastId).toBe(forecastId)
    expect(first.evaluatedOutcomeCount).toBe(0)
    expect(store.forecastCount()).toBe(1)
    expect(store.getForecast(forecastId)).toMatchObject({
      id: forecastId,
      version: '1',
      sourceMode: 'shadow_live',
      replayRunId: null,
      abstained: false,
      referencePrice: 134,
      horizon: '15m',
    })

    const second = service.runOnce(now)

    expect(second.outcome).toBe('duplicate')
    expect(second.forecastId).toBe(forecastId)
    expect(store.forecastCount()).toBe(1)
    expect(store.listOutcomes()).toHaveLength(0)
  })

  it('evaluates a pending forecast once its horizon has elapsed', () => {
    const { store, service } = makeService()
    for (let index = 0; index < 35; index += 1)
      seedBucket(store, index, 100 + index)
    const firstNow = (START + 35 * INTERVAL) as TimestampMs
    const first = service.runOnce(firstNow)
    const forecastId = first.forecastId
    expect(forecastId).not.toBeNull()
    expect(store.listOutcomes()).toHaveLength(0)

    seedBucket(store, 35, 200)
    const secondNow = (START + 36 * INTERVAL) as TimestampMs
    const second = service.runOnce(secondNow)

    expect(second.evaluatedOutcomeCount).toBe(1)
    const outcomes = store.listOutcomes()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      forecastId,
      observedPrice: 200,
      observedDataIsClosed: true,
    })
  })

  it('ignores stale observations so they never feed a live candle', () => {
    const { store, service } = makeService()
    for (let index = 0; index < 35; index += 1)
      seedBucket(store, index, 100 + index)
    seedBucket(store, 35, 9_999, { status: 'stale' })
    const now = (START + 36 * INTERVAL) as TimestampMs

    const result = service.runOnce(now)

    expect(result.outcome).toBe('generated')
    expect(result.forecastId).toBe(`shadow:BTC-EUR:${START + 35 * INTERVAL}`)
    expect(store.observationCount()).toBe(36)
    expect(store.getForecast(`shadow:BTC-EUR:${now}`)).toBeNull()
  })

  it('reports no_closed_candle while the first bucket is still open', () => {
    const { store, service } = makeService()
    seedBucket(store, 0, 100)

    const result = service.runOnce((START + 1_000) as TimestampMs)

    expect(result).toMatchObject({
      outcome: 'no_closed_candle',
      forecastId: null,
      evaluatedOutcomeCount: 0,
    })
    expect(store.forecastCount()).toBe(0)
  })

  it('never generates or evaluates for historical_replay', () => {
    const { store, service } = makeService()
    for (let index = 0; index < 35; index += 1)
      seedBucket(store, index, 100 + index)
    const replayAsOf = (START + 19 * INTERVAL) as TimestampMs
    store.insertForecast(
      historicalForecast('replay-run:BTC-EUR:' + replayAsOf, replayAsOf, 120),
    )
    const now = (START + 35 * INTERVAL) as TimestampMs

    const result = service.runOnce(now)

    expect(result.outcome).toBe('generated')
    expect(store.forecastCount()).toBe(2)
    expect(store.getForecast(`shadow:BTC-EUR:${now}`)?.sourceMode).toBe(
      'shadow_live',
    )
    expect(store.listOutcomes()).toHaveLength(0)
  })

  it('still persists an abstained forecast while features warm up', () => {
    const { store, service } = makeService()
    for (let index = 0; index < 5; index += 1)
      seedBucket(store, index, 100 + index)
    const now = (START + 5 * INTERVAL) as TimestampMs

    const result = service.runOnce(now)

    expect(result.outcome).toBe('generated')
    expect(result.forecastAbstained).toBe(true)
    const forecast = store.getForecast(`shadow:BTC-EUR:${now}`)
    expect(forecast?.abstained).toBe(true)
    expect(forecast?.abstentionReason).toBe('warmup_incomplete')
  })
})
