import { describe, expect, it } from 'vitest'
import { computeTechnicalFeatures } from './technical-features.ts'
import type { TechnicalCandle } from './technical-features.ts'
import type { TimestampMs } from '../../domain/contracts.ts'

function candles(count: number): TechnicalCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index
    return {
      interval: '1m',
      bucketStart: (index * 60_000) as TimestampMs,
      bucketEnd: ((index + 1) * 60_000) as TimestampMs,
      eventTimeStart: (index * 60_000) as TimestampMs,
      eventTimeEnd: ((index + 1) * 60_000) as TimestampMs,
      receivedTimeStart: (index * 60_000) as TimestampMs,
      receivedTimeEnd: ((index + 1) * 60_000) as TimestampMs,
      displayTimeStart: (index * 60_000) as TimestampMs,
      displayTimeEnd: ((index + 1) * 60_000) as TimestampMs,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: index + 1,
      tradeCount: 1,
      freshnessAgeMs: 0,
      freshnessIsStale: false,
      freshnessClockInverted: false,
      status: 'live',
      source: 'kraken',
      instrumentId: 'BTC-EUR',
      observationCount: 1,
      isClosed: true,
    }
  })
}

describe('rolling market features', () => {
  it('computes finite Bollinger, Donchian, volume and ATR percentile values causally', () => {
    const bars = candles(60)
    const result = computeTechnicalFeatures({
      candles: bars,
      asOfTimestamp: bars.at(-1)!.bucketEnd,
      includeMicroFeatures: true,
      params: {
        smaPeriod: 20,
        emaPeriod: 20,
        rsiPeriod: 14,
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        atrPeriod: 14,
        slopePeriod: 20,
      },
    })

    expect(result.rolling).toMatchObject({
      bollingerMid: 149.5,
      donchianHigh: 159,
      donchianLow: 138,
      volumeSma: 49.5,
      atrPercentile: 100,
    })
    expect(Object.values(result.rolling).every(Number.isFinite)).toBe(true)
    const truncated = computeTechnicalFeatures({
      candles: bars.slice(0, -1),
      asOfTimestamp: bars.at(-2)!.bucketEnd,
      includeMicroFeatures: true,
      params: {
        smaPeriod: 20,
        emaPeriod: 20,
        rsiPeriod: 14,
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        atrPeriod: 14,
        slopePeriod: 20,
      },
    })
    expect(result.rolling.donchianHigh!).toBeGreaterThan(
      truncated.rolling.donchianHigh!,
    )
    const extended = computeTechnicalFeatures({
      candles: candles(61),
      asOfTimestamp: bars.at(-1)!.bucketEnd,
      includeMicroFeatures: true,
      params: {
        smaPeriod: 20,
        emaPeriod: 20,
        rsiPeriod: 14,
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        atrPeriod: 14,
        slopePeriod: 20,
      },
    })
    expect(extended.rolling).toEqual(result.rolling)
  })
})
