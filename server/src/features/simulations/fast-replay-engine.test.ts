import { describe, expect, it } from 'vitest'
import { runFastReplay } from './fast-replay-engine.ts'

describe('runFastReplay', () => {
  it('rejects unsupported candidates and gaps, and returns deterministic metrics for a contiguous dataset', () => {
    const candles = Array.from({ length: 80 }, (_, index) => ({
      timestamp: 1_700_000_000 + index * 60,
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
    expect(result.candlesEvaluated).toBe(80)
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
      timestamp: 1_700_000_000 + index * 60,
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
    expect(result.sampleCount).toBe(19)
  })

  it('uses the flat probability shift when a Long entry is rejected by the expectancy gate', () => {
    const candles = Array.from({ length: 82 }, (_, index) => {
      const blockedBreakout = index === 66
      const postBreakout = index > 66
      return {
        timestamp: 1_700_000_000 + index * 60,
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
    expect(result.rawSignalsCount).toBe(1)
    expect(result.gateRejectionsCount).toBe(1)
    expect(result.sampleCount).toBe(1)
    expect(result.brierScoreMulticlass).toBeCloseTo(0, 12)
  })

  it('uses next-open fills, fixed euro ticket costs, and final-close liquidation', () => {
    const candles = Array.from({ length: 52 }, (_, index) => ({
      timestamp: 1_700_000_000 + index * 60,
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
    expect(result.trades.map(({ side }) => side)).toEqual(['buy', 'sell'])
    expect(result.rawSignalsCount).toBe(1)
    expect(result.gateRejectionsCount).toBe(0)
    expect(result.trades[0]?.price).toBeCloseTo(212 * 1.0005)
    expect(result.trades[0]?.feeEur).toBeCloseTo(0.03)
    expect(result.trades[1]?.price).toBeCloseTo(212 * 0.9995)
    expect(result.trades[1]?.feeEur).toBeCloseTo(
      (30 / (212 * 1.0005)) * 212 * 0.9995 * 0.001,
    )
    expect(result.tradesCount).toBe(1)
    expect(result.netPnlEur).toBeLessThan(0)
  })

  it('counts a gate-passing terminal raw signal without treating it as rejected', () => {
    const candles = Array.from({ length: 51 }, (_, index) => ({
      timestamp: 1_700_000_000 + index * 60,
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
    expect(result.rawSignalsCount).toBe(1)
    expect(result.gateRejectionsCount).toBe(0)
  })

  it('runs the complete 720-candle path and exposes measured execution time', () => {
    const candles = Array.from({ length: 720 }, (_, index) => ({
      timestamp: 1_700_000_000 + index * 60,
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
    expect(result.candlesEvaluated).toBe(720)
    expect(result.sampleCount).toBe(639)
    expect(Number.isFinite(result.executionTimeMs)).toBe(true)
  })
})
