import { describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import type { StoredMarketObservation } from './market-store.ts'
import { buildIntradayCandles } from './intraday-candles.ts'
import {
  computeTechnicalFeatures,
  toTechnicalFeatureSnapshot,
  type TechnicalCandle,
} from '../technical-analysis/technical-features.ts'

const baseTime = Date.parse('2026-09-21T10:00:00.000Z') as TimestampMs

function observation(
  offsetMs: number,
  price: number,
  options: {
    size?: number
    sequence?: number
    tradeId?: number
    contentHash?: string
    status?: StoredMarketObservation['status']
  } = {},
): StoredMarketObservation {
  const eventTime = (baseTime + offsetMs) as TimestampMs
  const payload = {
    type: 'ticker' as const,
    productId: 'BTC-EUR' as const,
    tradeId: options.tradeId ?? Math.max(1, offsetMs + 1),
    sequence: options.sequence ?? Math.max(1, offsetMs + 1),
    price,
    ...(options.size === undefined ? {} : { size: options.size }),
  }
  return {
    id: `observation-${offsetMs}-${price}`,
    source: 'fixture',
    instrumentId: 'BTC-EUR',
    eventTime,
    receivedTime: (eventTime + 10) as TimestampMs,
    displayTime: (eventTime + 20) as TimestampMs,
    sequence: payload.sequence,
    status: options.status ?? 'live',
    payload,
    freshnessAgeMs: 20,
    freshnessIsStale: false,
    contentHash: options.contentHash ?? `hash-${offsetMs}-${price}`,
    createdAt: (eventTime + 30) as TimestampMs,
  }
}

function tradeObservation(
  offsetMs: number,
  price: number,
  qty: number,
  options: {
    sequence?: number
    tradeId?: number
    side?: 'buy' | 'sell'
    status?: StoredMarketObservation['status']
  } = {},
): StoredMarketObservation {
  const eventTime = (baseTime + offsetMs) as TimestampMs
  const payload = {
    type: 'trade' as const,
    productId: 'BTC-EUR' as const,
    tradeId: options.tradeId ?? Math.max(1, offsetMs + 1),
    sequence: options.sequence ?? Math.max(1, offsetMs + 1),
    price,
    qty,
    side: options.side ?? ('buy' as const),
  }
  return {
    id: `trade-${offsetMs}-${price}`,
    source: 'fixture',
    instrumentId: 'BTC-EUR',
    eventTime,
    receivedTime: (eventTime + 10) as TimestampMs,
    displayTime: (eventTime + 20) as TimestampMs,
    sequence: payload.sequence,
    status: options.status ?? 'live',
    payload,
    freshnessAgeMs: 20,
    freshnessIsStale: false,
    contentHash: `trade-hash-${offsetMs}-${price}`,
    createdAt: (eventTime + 30) as TimestampMs,
  }
}

function candle(
  index: number,
  close: number,
  options: { closed?: boolean; high?: number; low?: number } = {},
): TechnicalCandle {
  const bucketStart = (baseTime + index * 60_000) as TimestampMs
  return {
    interval: '1m',
    bucketStart,
    bucketEnd: (bucketStart + 60_000) as TimestampMs,
    open: close,
    high: options.high ?? close + 1,
    low: options.low ?? Math.max(0.1, close - 1),
    close,
    volume: 1,
    eventTimeStart: bucketStart,
    eventTimeEnd: (bucketStart + 30_000) as TimestampMs,
    receivedTimeStart: bucketStart,
    receivedTimeEnd: (bucketStart + 30_000) as TimestampMs,
    displayTimeStart: bucketStart,
    displayTimeEnd: (bucketStart + 30_000) as TimestampMs,
    freshnessAgeMs: 0,
    freshnessIsStale: false,
    freshnessClockInverted: false,
    status: 'live',
    source: 'fixture',
    instrumentId: 'BTC-EUR',
    observationCount: 1,
    isClosed: options.closed ?? true,
  }
}

describe('buildIntradayCandles', () => {
  it.each([
    ['1m', 60_000],
    ['5m', 300_000],
    ['15m', 900_000],
    ['1h', 3_600_000],
  ] as const)('uses deterministic UTC buckets for %s', (interval, duration) => {
    const result = buildIntradayCandles({
      interval,
      asOfTimestamp: (baseTime + duration + 1) as TimestampMs,
      observations: [
        observation(0, 100, { size: 2 }),
        observation(duration - 1, 110, { size: 3 }),
        observation(duration, 120, { size: 4 }),
      ],
    })

    expect(result.closed.map((item) => item.bucketStart)).toEqual([baseTime])
    expect(result.provisional?.bucketStart).toBe(
      (baseTime + duration) as TimestampMs,
    )
    expect(result.closed[0]).toMatchObject({
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      volume: 5,
      eventTimeStart: baseTime,
      eventTimeEnd: (baseTime + duration - 1) as TimestampMs,
      isClosed: true,
    })
  })

  it('closes an exact boundary and keeps the next bucket provisional', () => {
    const result = buildIntradayCandles({
      interval: '5m',
      asOfTimestamp: (baseTime + 300_000) as TimestampMs,
      observations: [observation(299_999, 100), observation(300_000, 101)],
    })

    expect(result.closed).toHaveLength(1)
    expect(result.provisional?.bucketStart).toBe(
      (baseTime + 300_000) as TimestampMs,
    )
  })

  it('replaces a provisional candle when later ticks arrive without duplication', () => {
    const result = buildIntradayCandles({
      interval: '1m',
      asOfTimestamp: (baseTime + 90_000) as TimestampMs,
      observations: [observation(60_000, 101), observation(75_000, 103)],
    })

    expect(result.provisional).toMatchObject({
      bucketStart: (baseTime + 60_000) as TimestampMs,
      open: 101,
      high: 103,
      close: 103,
      observationCount: 2,
    })
    expect(result.all.filter((item) => !item.isClosed)).toHaveLength(1)
  })

  it('sorts out-of-order observations and removes duplicate identities', () => {
    const first = observation(10_000, 101, { sequence: 2, tradeId: 2 })
    const second = observation(1_000, 100, { sequence: 1, tradeId: 1 })
    const duplicate = {
      ...first,
      id: 'replayed',
      receivedTime: first.receivedTime,
    }
    const result = buildIntradayCandles({
      interval: '1m',
      asOfTimestamp: (baseTime + 60_000) as TimestampMs,
      observations: [first, duplicate, second],
    })

    expect(result.closed[0]).toMatchObject({
      open: 100,
      close: 101,
      observationCount: 2,
    })
    expect(result.duplicateCount).toBe(1)
    expect(result.outOfOrderCount).toBe(1)
  })

  it('rejects invalid timestamps, excludes future ticks, and preserves gap metrics', () => {
    const invalid = { ...observation(1_000, 100), eventTime: -1 }
    const result = buildIntradayCandles({
      interval: '1m',
      asOfTimestamp: (baseTime + 60_000) as TimestampMs,
      observations: [
        invalid,
        observation(1_000, 100),
        observation(61_000, 102),
      ],
      gapMetrics: {
        gapCount: 1,
        expectedOpportunities: 10,
        rate: 0.1,
        sequenceAvailable: true,
      },
    })

    expect(result.rejected).toMatchObject([
      { code: 'invalid_timestamp' },
      { code: 'future_observation' },
    ])
    expect(result.gapMetrics).toEqual({
      gapCount: 1,
      expectedOpportunities: 10,
      rate: 0.1,
      sequenceAvailable: true,
    })
  })

  it('keeps freshness and uses conservative status precedence', () => {
    const stale = observation(1_000, 100, { status: 'stale' })
    const gap = {
      ...observation(2_000, 101, { status: 'gap' }),
      freshnessAgeMs: 40,
      freshnessIsStale: true,
    }
    const result = buildIntradayCandles({
      interval: '1m',
      asOfTimestamp: (baseTime + 60_000) as TimestampMs,
      observations: [stale, gap],
    })

    expect(result.closed[0]).toMatchObject({
      status: 'gap',
      freshnessAgeMs: 40,
      freshnessIsStale: true,
    })
  })

  it('aggregates trade payloads into candles using qty as volume', () => {
    const result = buildIntradayCandles({
      interval: '1m',
      asOfTimestamp: (baseTime + 60_000) as TimestampMs,
      observations: [
        tradeObservation(0, 100, 2, { sequence: 1, tradeId: 1 }),
        tradeObservation(30_000, 110, 3, { sequence: 2, tradeId: 2 }),
      ],
    })

    expect(result.rejected).toEqual([])
    expect(result.closed[0]).toMatchObject({
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      volume: 5,
      observationCount: 2,
      status: 'live',
    })
  })

  it('rejects invalid trade payloads and still rejects heartbeats', () => {
    const invalidQty = {
      ...tradeObservation(1_000, 100, 1),
      payload: {
        type: 'trade' as const,
        productId: 'BTC-EUR' as const,
        tradeId: 1,
        sequence: 1,
        price: 100,
        qty: 0,
        side: 'buy' as const,
      },
    }
    const invalidPrice = {
      ...tradeObservation(2_000, 100, 1),
      payload: {
        type: 'trade' as const,
        productId: 'BTC-EUR' as const,
        tradeId: 2,
        sequence: 2,
        price: -1,
        qty: 1,
        side: 'buy' as const,
      },
    }
    const heartbeat = {
      ...observation(3_000, 100),
      payload: {
        type: 'heartbeat' as const,
        productId: 'BTC-EUR' as const,
        sequence: 3,
        lastTradeId: 3,
      },
    }
    const result = buildIntradayCandles({
      interval: '1m',
      asOfTimestamp: (baseTime + 60_000) as TimestampMs,
      observations: [invalidQty, invalidPrice, heartbeat],
    })

    expect(result.closed).toHaveLength(0)
    expect(result.rejected.map((item) => item.code)).toEqual([
      'unsupported_payload',
      'unsupported_payload',
      'unsupported_payload',
    ])
  })
})

describe('computeTechnicalFeatures', () => {
  const params = {
    smaPeriod: 3,
    emaPeriod: 3,
    rsiPeriod: 3,
    macdFastPeriod: 2,
    macdSlowPeriod: 3,
    macdSignalPeriod: 2,
    atrPeriod: 3,
    slopePeriod: 3,
  }

  it('computes known SMA, EMA, RSI, MACD, ATR, and slope values', () => {
    const result = computeTechnicalFeatures({
      candles: [1, 2, 3, 4, 5, 6].map((close, index) => candle(index, close)),
      asOfTimestamp: (baseTime + 6 * 60_000) as TimestampMs,
      params,
    })

    expect(result.ready).toBe(true)
    expect(result.indicators).toEqual({
      sma: 5,
      ema: 5,
      rsi: 100,
      macdLine: 0.5,
      macdSignal: 0.5,
      macdHistogram: 0,
      atr: 2,
      structuralSlope: 1,
      structuralTrend: 'up',
    })
    expect(result.technicalFeatureVersion).toBe('technical-features.v1')
    expect(result.paramSetVersion).toBe('technical-defaults.v1')
    expect(Object.values(result.values).every(Number.isFinite)).toBe(true)
  })

  it('reports warm-up without fabricated values and ignores an open candle', () => {
    const result = computeTechnicalFeatures({
      candles: [candle(0, 10), candle(1, 10, { closed: false })],
      asOfTimestamp: (baseTime + 2 * 60_000) as TimestampMs,
      params,
    })

    expect(result.ready).toBe(false)
    expect(result.candlesUsed).toBe(1)
    expect(result.indicators.sma).toBeNull()
    expect(result.values).toEqual({})
    expect(result.ignoredOpenCandleCount).toBe(1)
  })

  it('handles flat RSI and zero movement with finite values', () => {
    const result = computeTechnicalFeatures({
      candles: [1, 1, 1, 1, 1, 1].map((close, index) => candle(index, close)),
      asOfTimestamp: (baseTime + 6 * 60_000) as TimestampMs,
      params,
    })

    expect(result.indicators.rsi).toBe(50)
    expect(result.indicators.macdHistogram).toBe(0)
    expect(result.indicators.structuralTrend).toBe('flat')
    expect(Object.values(result.values).every(Number.isFinite)).toBe(true)
  })

  it('does not use candles after the explicit evidence cutoff', () => {
    const result = computeTechnicalFeatures({
      candles: [1, 2, 3, 4, 5, 6].map((close, index) => candle(index, close)),
      asOfTimestamp: (baseTime + 5 * 60_000) as TimestampMs,
      params,
    })

    expect(result.candlesUsed).toBe(5)
    expect(result.indicators.sma).toBe(4)
    expect(result.asOfTimestamp).toBe((baseTime + 5 * 60_000) as TimestampMs)
  })

  it('only exports a forecast snapshot after warm-up and keeps it closed', () => {
    const result = computeTechnicalFeatures({
      candles: [1, 2, 3, 4, 5, 6].map((close, index) => candle(index, close)),
      asOfTimestamp: (baseTime + 6 * 60_000) as TimestampMs,
      params,
    })

    expect(toTechnicalFeatureSnapshot(result)).toEqual({
      version: 'technical-features.v1',
      asOfTimestamp: (baseTime + 6 * 60_000) as TimestampMs,
      isClosed: true,
      ready: true,
      warmUp: result.warmUp,
      values: result.values,
    })
  })
})
