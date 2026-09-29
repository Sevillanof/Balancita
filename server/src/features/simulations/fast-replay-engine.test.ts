import { describe, expect, it } from 'vitest'
import {
  fastReplayFeaturesAt,
  resample1mTo15m,
  runFastReplay,
} from './fast-replay-engine.ts'
import type { FastReplayDecisionSnapshot } from './fast-replay-engine.ts'

describe('runFastReplay', () => {
  it('resamples only complete UTC-aligned buckets closed by the 1m cutoff', () => {
    const start = Math.floor(1_700_000_010 / 900) * 900
    const candles = Array.from({ length: 31 }, (_, index) => ({
      timestamp: start + index * 60,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 2,
    }))
    expect(resample1mTo15m(candles, start + 900 - 1)).toEqual([])
    const complete = resample1mTo15m(candles, start + 15 * 60)
    expect(complete).toHaveLength(1)
    expect(complete[0]).toMatchObject({
      timestamp: start,
      open: 100,
      high: 115,
      low: 99,
      close: 114.5,
      volume: 30,
    })
    expect(resample1mTo15m(candles, start + 15 * 60 + 60)).toHaveLength(1)
  })

  it('drops partial and missing-minute UTC buckets without overflowing the input', () => {
    const start = Math.floor(1_700_000_010 / 900) * 900
    const candles = Array.from({ length: 31 }, (_, index) => ({
      timestamp: start + index * 60,
      open: 100,
      high: 102,
      low: 98,
      close: 101,
      volume: 1,
    })).filter((_, index) => index !== 20)
    expect(resample1mTo15m(candles, start + 10_000)).toHaveLength(1)
    expect(resample1mTo15m(candles.slice(0, 14), start + 10_000)).toEqual([])
  })

  it('requires 50 ATR observations before exposing C28 percentile and computes it on native bars', () => {
    const history = Array.from({ length: 64 }, (_, index) => ({
      timestamp: 1_700_000_100 + index * 900,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1,
    }))
    expect(
      fastReplayFeaturesAt(history.slice(0, 63)).atrPercentile50,
    ).toBeNull()
    expect(fastReplayFeaturesAt(history).atrPercentile50).not.toBeNull()
  })

  it('rejects unsupported candidates and gaps, and returns deterministic metrics for a contiguous dataset', () => {
    const candles = Array.from({ length: 80 }, (_, index) => ({
      timestamp: 1_700_000_100 + index * 60,
      open: 30_000 + index,
      high: 30_002 + index,
      low: 29_999 + index,
      close: 30_001 + index,
      volume: 10,
    }))
    const result = runFastReplay({
      strategyId: 'micro-bollinger-reversion',
      candles,
      ticketEur: 30,
    })
    expect(result.candlesEvaluated).toBe(5)
    expect(result.feeScenario.version).toBe(
      'kraken-pro-spot-btc-eur-tier1-taker.v1',
    )
    expect(result.feeScenario.commissionRate).toBe(0.008)
    expect(result.feeScenario.slippageRate).toBe(0.0005)
    expect(result.costCaveat).toMatch(/historical recorded fees.*unchanged/i)
    expect(result.baselineUniformBrier).toBe(0.6667)
    expect(Number.isFinite(result.executionTimeMs)).toBe(true)
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0)
    expect(result.sampleCount).toBe(0)
    expect(result.brierScoreMulticlass).toBeNull()
    expect(result.baselineNoChangeBrier).toBeNull()
    expect(result.trades).toEqual([])
  })

  it('does not score any forecast origin before a past outcome has matured', () => {
    const candles = Array.from({ length: 100 }, (_, index) => ({
      timestamp: 1_700_000_100 + index * 60,
      open: 30_000,
      high: 30_002,
      low: 29_999,
      close: 30_001,
      volume: 10,
    }))
    const result = runFastReplay({
      strategyId: 'micro-bollinger-reversion',
      candles,
      ticketEur: 30,
    })
    expect(result.sampleCount).toBe(0)
  })

  it('does not emit a raw C27 breakout before macro Donchian warm-up', () => {
    const candles = Array.from({ length: 82 }, (_, index) => {
      const blockedBreakout = index === 66
      const postBreakout = index > 66
      return {
        timestamp: 1_700_000_100 + index * 60,
        open: blockedBreakout ? 100.2 : postBreakout ? 100.2 : 100,
        high: blockedBreakout ? 100.21 : postBreakout ? 100.25 : 100.05,
        low: blockedBreakout ? 100.19 : postBreakout ? 100.15 : 99.95,
        close: blockedBreakout || postBreakout ? 100.2 : 100,
        volume: blockedBreakout ? 2 : 1,
      }
    })
    const result = runFastReplay({
      strategyId: 'micro-donchian-breakout',
      candles,
      ticketEur: 30,
    })
    expect(result.trades).toEqual([])
    expect(result.rawSignalsCount).toBe(0)
    expect(result.gateRejectionsCount).toBe(0)
    expect(result.sampleCount).toBe(0)
    expect(result.brierScoreMulticlass).toBeNull()
  })

  it('does not emit a C27 raw breakout when the 15m Donchian channel is unavailable', () => {
    const candles = Array.from({ length: 52 }, (_, index) => ({
      timestamp: 1_700_000_100 + index * 60,
      open: index === 51 ? 212 : index === 50 ? 210 : 100,
      high: index === 50 ? 211 : index === 51 ? 220 : 200,
      low: index === 50 ? 209 : 1,
      close: index >= 50 ? 210 + (index - 50) * 2 : 100,
      volume: index === 50 ? 10 : 1,
    }))
    const result = runFastReplay({
      strategyId: 'micro-donchian-breakout',
      candles,
      ticketEur: 30,
    })
    expect(result.trades).toEqual([])
    expect(result.rawSignalsCount).toBe(0)
    expect(result.gateRejectionsCount).toBe(0)
  })

  it('does not fabricate a terminal C27 breakout without 15m features', () => {
    const candles = Array.from({ length: 51 }, (_, index) => ({
      timestamp: 1_700_000_100 + index * 60,
      open: index === 50 ? 210 : 100,
      high: index === 50 ? 211 : 200,
      low: index === 50 ? 209 : 1,
      close: index === 50 ? 210 : 100,
      volume: index === 50 ? 10 : 1,
    }))
    const result = runFastReplay({
      strategyId: 'micro-donchian-breakout',
      candles,
      ticketEur: 30,
    })
    expect(result.trades).toEqual([])
    expect(result.rawSignalsCount).toBe(0)
    expect(result.gateRejectionsCount).toBe(0)
  })

  it('does not open C27 before completed macro features are available', () => {
    const candles = Array.from({ length: 53 }, (_, index) => ({
      timestamp: 1_700_000_000 + index * 60,
      open: index === 51 ? 100 : index === 52 ? 90 : 100,
      high: index === 50 ? 211 : 200,
      low: index === 51 ? 98 : 1,
      close: index === 50 ? 210 : index === 51 ? 99 : 90,
      volume: index === 50 ? 10 : 1,
    }))
    const result = runFastReplay({
      strategyId: 'micro-donchian-breakout',
      candles,
      ticketEur: 30,
    })
    expect(result.trades).toEqual([])
    expect(result.rawSignalsCount).toBe(0)
    expect(result.gateRejectionsCount).toBe(0)
  })

  it('does not fill a replay signal when its next native 15m open is incomplete', () => {
    const start = Math.floor(1_700_000_100 / 900) * 900
    const candles = Array.from({ length: 1_103 }, (_, index) => {
      const breakout = index === 1_100
      const firstAfterBreakout = index === 1_101
      const final = index === 1_102
      return {
        timestamp: start + index * 60,
        open: breakout
          ? 101
          : firstAfterBreakout
            ? 100.9
            : final
              ? 100.8
              : 100.65,
        high: breakout
          ? 101.2
          : firstAfterBreakout
            ? 101.1
            : final
              ? 101
              : index >= 1_080
                ? 100.7
                : 101,
        low: breakout
          ? 101
          : firstAfterBreakout
            ? 100.5
            : final
              ? 100.4
              : index >= 1_080
                ? 100.6
                : 100,
        close: breakout ? 101.1 : firstAfterBreakout || final ? 100.53 : 100.65,
        volume: breakout ? 20 : 10,
      }
    })
    const result = runFastReplay({
      strategyId: 'micro-donchian-breakout',
      candles,
      ticketEur: 30,
    })

    expect(result.trades).toEqual([])
  })

  it('runs the complete 720-candle path and exposes measured execution time', () => {
    const candles = Array.from({ length: 720 }, (_, index) => ({
      timestamp: 1_700_000_100 + index * 60,
      open: 30_000 + Math.sin(index / 8) * 20,
      high: 30_030 + Math.sin(index / 8) * 20,
      low: 29_970 + Math.sin(index / 8) * 20,
      close: 30_000 + Math.sin(index / 8) * 20,
      volume: 100,
    }))
    const result = runFastReplay({
      strategyId: 'micro-regime-adapter',
      candles,
      ticketEur: 30,
    })
    expect(result.candlesEvaluated).toBe(48)
    expect(result.sampleCount).toBe(0)
    expect(Number.isFinite(result.executionTimeMs)).toBe(true)
  })

  it('evaluates only complete contiguous native 15m candles', () => {
    const start = 1_700_000_100
    const candles = Array.from({ length: 46 }, (_, index) => ({
      timestamp: start + index * 60,
      open: 30_000,
      high: 30_002,
      low: 29_999,
      close: 30_001,
      volume: 10,
    }))
    const result = runFastReplay({
      strategyId: 'micro-bollinger-reversion',
      candles,
      ticketEur: 30,
    })
    expect(result.candlesEvaluated).toBe(3)
  })

  it('rejects gapped 1m replay input instead of silently dropping affected buckets', () => {
    const start = 1_700_000_100
    const candles = Array.from({ length: 31 }, (_, index) => ({
      timestamp: start + index * 60,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    })).filter((_, index) => index !== 20)

    expect(() =>
      runFastReplay({
        strategyId: 'micro-trend-pullback',
        candles,
        ticketEur: 30,
      }),
    ).toThrow(/contains 1 gap\(s\)/)
  })

  it('reports an open replay position without fabricating a terminal sell fill', () => {
    const start = 1_700_000_100
    const candles = Array.from({ length: 51 * 15 }, (_, index) => {
      const nativeBar = Math.floor(index / 15)
      const breakout = nativeBar === 49
      const afterBreakout = nativeBar === 50
      return {
        timestamp: start + index * 60,
        open: breakout || afterBreakout ? 102 : 100,
        high: breakout ? 103 : afterBreakout ? 102.5 : 101,
        low: breakout ? 99 : afterBreakout ? 101.5 : 99,
        close: breakout || afterBreakout ? 102 : 100,
        volume: breakout ? 20 : 1,
      }
    })
    const trace: FastReplayDecisionSnapshot[] = []
    const input = {
      strategyId: 'micro-donchian-breakout',
      candles,
      ticketEur: 30,
    }
    const result = runFastReplay({
      ...input,
      onDecision: (snapshot) => trace.push(snapshot),
    })
    const repeatedTrace: FastReplayDecisionSnapshot[] = []
    runFastReplay({
      ...input,
      onDecision: (snapshot) => repeatedTrace.push(snapshot),
    })
    const withoutObserver = runFastReplay(input)

    expect(result.trades.map(({ side }) => side)).toEqual(['buy'])
    expect(trace).toHaveLength(2)
    expect(repeatedTrace).toEqual(trace)
    expect(Object.isFrozen(trace[0])).toBe(true)
    expect(Object.isFrozen(trace[0]?.fill)).toBe(true)
    expect(trace[0]).toMatchObject({
      timestamp: start + 49 * 900,
      rawTarget: 'long',
      abstained: false,
      entryGate: 'accepted',
      effectiveTarget: 'long',
      fill: { scheduled: true, timestamp: start + 50 * 900, side: 'buy' },
      postExposure: 'long',
    })
    expect(trace[1]).toMatchObject({
      timestamp: start + 50 * 900,
      fill: { scheduled: false, timestamp: null, side: null },
      postExposure: 'long',
    })
    expect({ ...result, executionTimeMs: 0 }).toEqual({
      ...withoutObserver,
      executionTimeMs: 0,
    })
    expect(result.openPositionAtEnd).toMatchObject({
      entryPrice: 102 * 1.0005,
      entryCostEur: 30.24,
    })
    expect(result.tradesCount).toBe(0)
    expect(result.netPnlEur).toBe(0)
  })

  it('traces a native long signal rejected by the FastReplay entry gate', () => {
    const start = Math.floor(1_700_000_100 / 900) * 900
    const nativeBars = Array.from({ length: 50 }, (_, index) => ({
      timestamp: start + index * 900,
      open: 100,
      high: index === 49 ? 100.6 : 100.4,
      low: 100,
      close: index === 49 ? 100.5 : 100.2,
      volume: index === 49 ? 2 : 1,
    }))
    const candles = nativeBars.flatMap((bar) =>
      Array.from({ length: 15 }, (_, minute) => ({
        timestamp: bar.timestamp + minute * 60,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume / 15,
      })),
    )
    const trace: FastReplayDecisionSnapshot[] = []
    const input = {
      strategyId: 'micro-donchian-breakout',
      candles,
      ticketEur: 30,
    }
    const result = runFastReplay({
      ...input,
      onDecision: (snapshot) => trace.push(snapshot),
    })
    const withoutObserver = runFastReplay(input)

    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatchObject({
      timestamp: start + 49 * 900,
      rawTarget: 'long',
      entryGate: 'rejected',
      entryGateReason: 'entry_gate_rejected',
      effectiveTarget: 'flat',
      fill: { scheduled: false, performed: false, timestamp: null, side: null },
      postExposure: 'flat',
    })
    expect(result.rawSignalsCount).toBe(1)
    expect(result.gateRejectionsCount).toBe(1)
    expect(result.trades).toEqual([])
    expect({ ...result, executionTimeMs: 0 }).toEqual({
      ...withoutObserver,
      executionTimeMs: 0,
    })
  })

  it('traces a C27 stop-loss exit from the native long position at the next open', () => {
    const start = Math.floor(1_700_000_100 / 900) * 900
    const nativeBars = Array.from({ length: 52 }, (_, index) => {
      const breakout = index === 49
      const stoppedOut = index === 50
      return {
        timestamp: start + index * 900,
        open: breakout ? 102 : stoppedOut ? 100 : 100,
        high: breakout ? 103 : 101,
        low: breakout ? 99 : 99,
        close: breakout ? 102 : stoppedOut ? 100 : 100,
        volume: breakout ? 20 : 1,
      }
    })
    const candles = nativeBars.flatMap((bar) =>
      Array.from({ length: 15 }, (_, minute) => ({
        timestamp: bar.timestamp + minute * 60,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume / 15,
      })),
    )
    const trace: FastReplayDecisionSnapshot[] = []
    const input = {
      strategyId: 'micro-donchian-breakout',
      candles,
      ticketEur: 30,
    }
    const result = runFastReplay({
      ...input,
      onDecision: (snapshot) => trace.push(snapshot),
    })
    const withoutObserver = runFastReplay(input)

    expect(result.trades.map(({ side }) => side)).toEqual(['buy', 'sell'])
    expect(trace[0]).toMatchObject({
      rawTarget: 'long',
      fill: { side: 'buy', scheduled: true, performed: true },
      postExposure: 'long',
    })
    expect(trace[1]).toMatchObject({
      timestamp: start + 50 * 900,
      priorExposure: 'long',
      fill: {
        scheduled: true,
        performed: true,
        timestamp: start + 51 * 900,
        side: 'sell',
      },
      postExposure: 'flat',
    })
    expect({ ...result, executionTimeMs: 0 }).toEqual({
      ...withoutObserver,
      executionTimeMs: 0,
    })
  })
})
