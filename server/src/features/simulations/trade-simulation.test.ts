import { describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import {
  DEFAULT_ENTRY_THRESHOLD,
  DEFAULT_EXIT_DOWN_THRESHOLD,
  DEFAULT_EXIT_UP_THRESHOLD,
  DEFAULT_STARTING_CASH,
  DEFAULT_TRADE_COSTS,
  STRATEGY_RULE_VERSION,
  TRADE_COSTS_VERSION,
  momentumSignalsFor,
  simulateBuyAndHold,
  simulateLongFlat,
  uniformSignalsFor,
  type TradeSimBar,
  type TradeSimSignal,
} from './trade-simulation.ts'

const MINUTE_MS = 60_000
const T0 = 1_700_000_000_000

function bar(index: number, open: number, close: number): TradeSimBar {
  return {
    time: (T0 + (index + 1) * MINUTE_MS) as TimestampMs,
    open,
    close,
  }
}

function signal(
  index: number,
  probabilityUp: number,
  probabilityDown: number,
  abstained = false,
): TradeSimSignal {
  return {
    time: (T0 + (index + 1) * MINUTE_MS) as TimestampMs,
    probabilityUp,
    probabilityDown,
    abstained,
  }
}

const LONG = (index: number): TradeSimSignal => signal(index, 0.8, 0.1)
const FLAT = (index: number): TradeSimSignal => signal(index, 0.2, 0.2)

describe('trade simulation strategy-rule.v2', () => {
  it('executes explicit micro target states independently of forecast probabilities', () => {
    const bars = [bar(0, 100, 100), bar(1, 101, 101), bar(2, 99, 99)]
    const result = simulateLongFlat({
      bars,
      signals: [
        { ...signal(0, 0.1, 0.8), directTarget: 'long' },
        { ...signal(1, 0.9, 0.05), directTarget: 'flat' },
      ],
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    expect(result.fills.map(({ side }) => side)).toEqual(['buy', 'sell'])
    expect(result.metrics.fillCount).toBe(2)
    expect(result.metrics.tradeCount).toBe(1)
  })

  it('counts a terminal open micro position as one fill and no closed round-trip', () => {
    const result = simulateLongFlat({
      bars: [bar(0, 100, 100), bar(1, 100, 105)],
      signals: [{ ...signal(0, 0.1, 0.8), directTarget: 'long' }],
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    expect(result.metrics.fillCount).toBe(1)
    expect(result.metrics.tradeCount).toBe(0)
  })

  it('exposes versioned defaults', () => {
    expect(STRATEGY_RULE_VERSION).toBe('strategy-rule.v2')
    expect(TRADE_COSTS_VERSION).toBe('costs.v1')
    expect(DEFAULT_ENTRY_THRESHOLD).toBe(0.55)
    expect(DEFAULT_EXIT_UP_THRESHOLD).toBe(0.45)
    expect(DEFAULT_EXIT_DOWN_THRESHOLD).toBe(0.55)
    expect(DEFAULT_TRADE_COSTS).toEqual({
      commissionRate: 0.001,
      slippageRate: 0.0005,
    })
    expect(DEFAULT_STARTING_CASH).toBe(10_000)
  })

  it('fills at the NEXT candle open, never at the signal candle close', () => {
    const bars = [bar(0, 100, 110), bar(1, 200, 210), bar(2, 300, 310)]
    const signals = [LONG(0), FLAT(1), FLAT(2)]
    const result = simulateLongFlat({
      bars,
      signals,
      startingCash: 10_000,
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    // Signal at candle 0 → buy fills at candle 1 open (200), never at 110.
    expect(result.fills).toHaveLength(2)
    expect(result.fills[0]).toMatchObject({ side: 'buy', price: 200 })
    expect(result.fills[0]!.qty).toBeCloseTo(10_000 / 200, 10)
    // Exit signal at candle 1 → sell fills at candle 2 open (300).
    expect(result.fills[1]).toMatchObject({ side: 'sell', price: 300 })
    expect(result.equityCurve.map(({ equity }) => equity)).toEqual([
      10_000, 10_500, 15_000,
    ])
    // One closed round-trip: (300 - 200) * 50 = +5000 → +50%.
    expect(result.metrics.tradeCount).toBe(1)
    expect(result.metrics.winRate).toBe(1)
    expect(result.metrics.profitFactor).toBeNull()
    expect(result.metrics.netReturnPct).toBeCloseTo(50, 10)
    expect(result.metrics.finalEquity).toBeCloseTo(15_000, 10)
  })

  it('applies commission and slippage on both legs with a hand-computable ledger', () => {
    const bars = [bar(0, 100, 100), bar(1, 100, 100), bar(2, 100, 100)]
    const signals = [LONG(0), FLAT(1), FLAT(2)]
    const costs = { commissionRate: 0.001, slippageRate: 0.0005 }
    const result = simulateLongFlat({
      bars,
      signals,
      startingCash: 10_000,
      costs,
    })
    // Buy: fill 100 * 1.0005 = 100.05; qty = 10000 / (100.05 * 1.001).
    const buyPrice = 100 * 1.0005
    const qty = 10_000 / (buyPrice * 1.001)
    expect(result.fills[0]).toMatchObject({ side: 'buy', price: buyPrice })
    expect(result.fills[0]!.qty).toBeCloseTo(qty, 8)
    // Sell: fill 100 * 0.9995 = 99.95; proceeds = qty * 99.95 * 0.999.
    const sellPrice = 100 * 0.9995
    const expected = qty * sellPrice * 0.999
    expect(result.fills[1]).toMatchObject({ side: 'sell', price: sellPrice })
    expect(result.metrics.finalEquity).toBeCloseTo(expected, 8)
    expect(result.metrics.netReturnPct).toBeCloseTo(
      (expected / 10_000 - 1) * 100,
      8,
    )
    expect(result.metrics.tradeCount).toBe(1)
    expect(result.metrics.winRate).toBe(0)
    expect(result.metrics.profitFactor).toBe(0)
  })

  it('exits to flat on abstention, low probabilityUp, or high probabilityDown', () => {
    const bars = [
      bar(0, 100, 100),
      bar(1, 100, 100),
      bar(2, 100, 100),
      bar(3, 100, 100),
      bar(4, 100, 100),
    ]
    // Enter at 0; then three different exit triggers on consecutive candles.
    const exitCases: Array<{ name: string; exit: TradeSimSignal }> = [
      { name: 'abstained', exit: signal(1, 0.9, 0.05, true) },
      { name: 'low-up', exit: signal(1, 0.4, 0.1) },
      { name: 'high-down', exit: signal(1, 0.6, 0.6) },
    ]
    for (const { exit } of exitCases) {
      const result = simulateLongFlat({
        bars: bars.slice(0, 3),
        signals: [LONG(0), exit, FLAT(2)],
        startingCash: 1_000,
        costs: { commissionRate: 0, slippageRate: 0 },
      })
      expect(result.fills.map((fill) => fill.side)).toEqual(['buy', 'sell'])
      expect(result.metrics.tradeCount).toBe(1)
    }
  })

  it('holds the position when a candle carries no signal', () => {
    const bars = [bar(0, 100, 100), bar(1, 100, 100), bar(2, 100, 100)]
    const result = simulateLongFlat({
      bars,
      signals: [LONG(0)],
      startingCash: 1_000,
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    // Bought at candle 1 open, never sold: no closed round-trip.
    expect(result.fills.map((fill) => fill.side)).toEqual(['buy'])
    expect(result.metrics.tradeCount).toBe(0)
    expect(result.metrics.winRate).toBeNull()
    expect(result.metrics.finalEquity).toBeCloseTo(1_000, 10)
  })

  it('drops a position change on the last candle: no next open exists', () => {
    const bars = [bar(0, 100, 100), bar(1, 100, 100)]
    const result = simulateLongFlat({
      bars,
      signals: [FLAT(0), LONG(1)],
      startingCash: 1_000,
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    expect(result.fills).toHaveLength(0)
    expect(result.metrics.tradeCount).toBe(0)
    expect(result.metrics.finalEquity).toBe(1_000)
  })

  it('reports exposure, drawdown, and losing round-trips', () => {
    const bars = [
      bar(0, 100, 100),
      bar(1, 100, 120),
      bar(2, 120, 60),
      bar(3, 60, 60),
    ]
    const result = simulateLongFlat({
      bars,
      signals: [LONG(0), LONG(1), FLAT(2), FLAT(3)],
      startingCash: 1_200,
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    // Buy 12 units at 100; equity marks: 1200, 1440, 720, 720 (sold at 60 open of candle 3).
    expect(result.metrics.exposurePct).toBeCloseTo(50, 10)
    expect(result.metrics.maxDrawdownPct).toBeCloseTo(50, 10)
    expect(result.metrics.netReturnPct).toBeCloseTo(-40, 10)
    expect(result.metrics.tradeCount).toBe(1)
    expect(result.metrics.winRate).toBe(0)
  })

  it('handles empty and single-bar windows without fabricating trades', () => {
    const empty = simulateLongFlat({ bars: [], signals: [] })
    expect(empty.fills).toHaveLength(0)
    expect(empty.metrics.tradeCount).toBe(0)
    expect(empty.metrics.winRate).toBeNull()
    expect(empty.metrics.finalEquity).toBe(DEFAULT_STARTING_CASH)

    const single = simulateLongFlat({
      bars: [bar(0, 100, 110)],
      signals: [LONG(0)],
    })
    expect(single.fills).toHaveLength(0)
    expect(single.metrics.finalEquity).toBe(DEFAULT_STARTING_CASH)
  })

  it('is deterministic: same input yields the same ledger hash', () => {
    const bars = [bar(0, 100, 105), bar(1, 105, 95), bar(2, 95, 100)]
    const signals = [LONG(0), FLAT(1), LONG(2)]
    const first = simulateLongFlat({ bars, signals })
    const second = simulateLongFlat({ bars, signals })
    expect(first.ledgerHash).toMatch(/^[0-9a-f]{64}$/)
    expect(second.ledgerHash).toBe(first.ledgerHash)
    expect(second).toEqual(first)
  })

  it('simulates buy-and-hold from the first open to the last close', () => {
    const bars = [bar(0, 100, 110), bar(1, 110, 121)]
    const result = simulateBuyAndHold({
      bars,
      startingCash: 1_000,
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    expect(result.fills.map((fill) => fill.side)).toEqual(['buy', 'sell'])
    expect(result.metrics.tradeCount).toBe(1)
    expect(result.metrics.netReturnPct).toBeCloseTo(21, 10)
  })

  it('builds baseline signals: uniform stays flat, momentum repeats the last label', () => {
    const bars = [bar(0, 100, 100), bar(1, 100, 100), bar(2, 100, 100)]
    const uniform = simulateLongFlat({
      bars,
      signals: uniformSignalsFor(bars),
      startingCash: 1_000,
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    expect(uniform.fills).toHaveLength(0)
    expect(uniform.metrics.tradeCount).toBe(0)

    const momentum = simulateLongFlat({
      bars,
      signals: momentumSignalsFor(bars, ['up', 'down']),
      startingCash: 1_000,
      costs: { commissionRate: 0, slippageRate: 0 },
    })
    // First bar has no previous label → flat. 'up' at bar 0 → long
    // signalled at bar 1 → buy fills at bar 2 open. 'down' at bar 1 →
    // flat signalled at bar 2 → no next open, so the sell never fills.
    expect(momentum.fills.map((fill) => fill.side)).toEqual(['buy'])
  })
})
