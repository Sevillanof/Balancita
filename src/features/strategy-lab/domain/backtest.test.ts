import { describe, expect, it } from 'vitest'
import { buyAndHold, evaluateCondition, runBacktest } from './backtest.ts'
import { computeFeatures, type LabCandle } from './indicators.ts'
import { STRATEGY_SCHEMA, type StrategySpec } from './strategy-spec.ts'
import { C25, C28, BASE_STRATEGIES } from '../infrastructure/base-strategies.ts'
import { syntheticCandles } from '../infrastructure/lab-candles.ts'

function candle(time: number, close: number, spread = 1): LabCandle {
  return {
    time,
    open: close,
    high: close + spread,
    low: close - spread,
    close,
    volume: 1,
  }
}

const breakout: StrategySpec = {
  schema: STRATEGY_SCHEMA,
  id: 'c90-test',
  version: 1,
  name: 'test',
  products: ['PF_XBTUSD'],
  regime: [],
  params: { level: '105' },
  entry: {
    LONG: { left: '1m.candidate_close', op: '>', right: '$level' },
    SHORT: null,
  },
  exit: { LONG: null, SHORT: null },
  risk: { stop_atr: '1', target_atr: '2' },
  horizon_minutes: 0,
}

describe('evaluateCondition', () => {
  it('resolves params, constants and a scale, and waits for missing features', () => {
    const row = { '1m.volume': 10, '1m.prior_volume_mean20': 7 }
    expect(
      evaluateCondition(
        {
          left: '1m.volume',
          op: '>',
          right: '1m.prior_volume_mean20',
          scale: '$m',
        },
        row,
        { m: '1.25' },
      ),
    ).toBe(true)
    expect(
      evaluateCondition({ left: '1m.volume', op: '<', right: '9.5' }, row, {}),
    ).toBe(false)
    expect(
      evaluateCondition({ left: '1m.rsi14', op: '>', right: '50' }, row, {}),
    ).toBeUndefined()
  })
})

describe('runBacktest', () => {
  it('enters at the close that satisfies the rule and exits at the target, net of fees', () => {
    const candles = Array.from({ length: 20 }, (_, index) =>
      candle(index * 60, 100),
    )
    candles.push(candle(20 * 60, 106))
    candles.push({
      time: 21 * 60,
      open: 106,
      high: 200,
      low: 105.5,
      close: 150,
      volume: 1,
    })
    const result = runBacktest(breakout, candles, { feeRate: 0 })
    expect(result.trades).toHaveLength(1)
    const [trade] = result.trades
    expect(trade).toMatchObject({
      side: 'LONG',
      entryPrice: 106,
      exitReason: 'target',
    })
    expect(trade!.exitPrice).toBeGreaterThan(106)
    expect(result.wins).toBe(1)
    expect(result.hitRatePct).toBe(100)
    expect(result.returnPct).toBeCloseTo(
      ((trade!.exitPrice - 106) / 106) * 100,
      6,
    )
  })

  it('takes the stop first when one candle touches both levels', () => {
    const candles = Array.from({ length: 20 }, (_, index) =>
      candle(index * 60, 100),
    )
    candles.push(candle(20 * 60, 106))
    candles.push({
      time: 21 * 60,
      open: 106,
      high: 300,
      low: 1,
      close: 106,
      volume: 1,
    })
    const result = runBacktest(breakout, candles)
    expect(result.trades[0]!.exitReason).toBe('stop')
    expect(result.losses).toBe(1)
  })

  it('is deterministic and runs every base strategy, the adapter through its delegates', () => {
    const candles = syntheticCandles()
    const resolve = (id: string) =>
      BASE_STRATEGIES.find((spec) => spec.id === id)
    for (const spec of BASE_STRATEGIES) {
      const first = runBacktest(spec, candles, { resolve })
      expect(runBacktest(spec, candles, { resolve })).toEqual(first)
      expect(Number.isFinite(first.returnPct)).toBe(true)
    }
    const adapter = runBacktest(C28, candles, { resolve })
    for (const trade of adapter.trades)
      expect(['c25-pullback-perp-v1', 'c26-reversion-perp-v1']).toContain(
        trade.strategyId,
      )
  })

  it('changes the result when a parameter changes', () => {
    const candles = syntheticCandles()
    const loose = {
      ...C25,
      params: {
        ...C25.params,
        rsi_min: '0',
        rsi_max: '100',
        rsi_short_min: '0',
        rsi_short_max: '100',
      },
    }
    expect(runBacktest(loose, candles).trades.length).toBeGreaterThanOrEqual(
      runBacktest(C25, candles).trades.length,
    )
  })
})

describe('buyAndHold', () => {
  it('returns the first-to-last move minus one round trip of fees', () => {
    const result = buyAndHold([candle(0, 100), candle(60, 110)], {
      feeRate: 0.0005,
    })
    expect(result.returnPct).toBeCloseTo(10 - 0.1, 6)
    expect(result.hitRatePct).toBeNull()
  })
})

describe('computeFeatures', () => {
  it('fills prev and 5m trend features once enough candles exist', () => {
    const rows = computeFeatures(syntheticCandles(300))
    const last = rows.at(-1)!
    for (const key of [
      '1m.rsi14',
      '1m.atr14',
      '1m.donchian_high20',
      'prev.ema21',
      '5m.ema21',
      '1m.bollinger_mid20',
    ])
      expect(last[key]).toEqual(expect.any(Number))
    expect(rows[0]!['1m.rsi14']).toBeUndefined()
  })
})
