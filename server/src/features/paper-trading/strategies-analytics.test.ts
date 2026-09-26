import { describe, expect, it } from 'vitest'
import {
  buildStrategyPositions,
  getStrategiesAnalyticsSummary,
  summarizeStrategies,
} from './strategies-analytics.ts'
import type { PaperOrder } from '../market-data/market-store.ts'
import type {
  MicroStrategyFeatures,
  MicroRegime,
} from '../simulations/micro-strategy.ts'

const order = (overrides: Partial<PaperOrder>): PaperOrder => ({
  id: 1,
  strategyId: 'micro-trend-pullback',
  signalTimestamp: 900,
  action: 'BUY',
  gatePassed: true,
  price: 100,
  executionTimestamp: 900,
  amountEur: 30,
  feeEur: 0.03,
  pnlEur: null,
  targetPct: 0,
  ...overrides,
})

const readyFeatures = (
  overrides: Partial<MicroStrategyFeatures> = {},
): MicroStrategyFeatures => ({
  ema9: 100,
  ema21: 99,
  sma50: 100,
  rsi14: 50,
  close: 100,
  bollingerLower: 98,
  bollingerMid: 101,
  bollingerUpper: 102,
  bollingerWidth: 4,
  atr14: 2,
  priorAtrSma20: 2,
  donchianHigh20: 105,
  donchianLow20: 95,
  donchianMid20: 100,
  volume: 10,
  priorVolumeSma20: 10,
  atrPercentile50: 50,
  ready: true,
  ...overrides,
})

const openPosition = (strategyId: PaperOrder['strategyId']) =>
  order({ strategyId, id: 77, executionTimestamp: 900 })

describe('strategy analytics summary', () => {
  it('returns all four zero-valued strategies and live Brier as unavailable', () => {
    const result = summarizeStrategies([])
    expect(result).toHaveLength(4)
    expect(result.map(({ strategy_id }) => strategy_id)).toEqual([
      'micro-trend-pullback',
      'micro-bollinger-reversion',
      'micro-donchian-breakout',
      'micro-regime-adapter',
    ])
    expect(result[0]).toMatchObject({
      name: 'C25: Trend Pullback',
      total_signals: 0,
      gate_rejections: 0,
      executed_buys: 0,
      strategy_id: 'micro-trend-pullback',
      approval_rate_pct: 0,
      assigned_capital_eur: 30,
      open_positions_count: 0,
      net_pnl_pct: 0,
      brier_score: null,
      profit_factor: null,
      win_rate_pct: 0,
      avg_holding_bars_15m: 0,
    })
  })

  it('separates raw signals from gate rejects and pairs executed round trips causally', () => {
    const rows = [
      order({ id: 1, gatePassed: false, executionTimestamp: null, feeEur: 0 }),
      order({
        id: 2,
        signalTimestamp: 1800,
        price: 100,
        feeEur: 0.03,
        executionTimestamp: 1800,
      }),
      order({
        id: 3,
        signalTimestamp: 2700,
        executionTimestamp: 2700,
        action: 'SELL',
        price: 110,
        feeEur: 0.033,
        pnlEur: 2.9,
      }),
      order({
        id: 4,
        signalTimestamp: 3600,
        executionTimestamp: 3600,
        price: 100,
        feeEur: 0.03,
      }),
      order({
        id: 5,
        signalTimestamp: 4500,
        executionTimestamp: 4500,
        action: 'SELL',
        price: 90,
        feeEur: 0.027,
        pnlEur: -3.027,
      }),
      order({
        id: 6,
        signalTimestamp: 5400,
        executionTimestamp: 5400,
        price: 100,
        feeEur: 0.03,
      }),
    ]
    const metric = summarizeStrategies(rows)[0]!
    expect(metric).toMatchObject({
      total_signals: 4,
      gate_rejections: 1,
      executed_buys: 3,
      executed_sells: 2,
      closed_trades: 2,
      wins: 1,
      profit_factor: expect.closeTo(2.9 / 3.027),
      avg_holding_bars_15m: 1,
    })
    expect(metric.net_pnl_eur).toBeCloseTo(-0.127)
    expect(metric.gross_pnl_eur).toBeCloseTo(0.0529365)
    expect(metric.total_fees_eur).toBeCloseTo(0.15)
    expect(metric.total_slippage_eur).toBeCloseTo(0.0749365)
    expect(metric.toll_ratio).toBeCloseTo((0.15 + 0.0749365) / 0.0529365)
  })

  it('keeps open and unmatched/rejected orders out of closed trade metrics', () => {
    const metric = summarizeStrategies([
      order({ id: 1, gatePassed: false, executionTimestamp: null }),
      order({ id: 2, action: 'SELL', pnlEur: -2 }),
      order({ id: 3, signalTimestamp: 2700, feeEur: 0.03 }),
    ])[0]!
    expect(metric.closed_trades).toBe(0)
    expect(metric.profit_factor).toBeNull()
    expect(metric.net_pnl_eur).toBe(0)
    expect(metric.total_slippage_eur).toBeCloseTo(0.015)
  })

  it('returns null profit factor when there are wins but no losses', () => {
    const metric = summarizeStrategies([
      order({ id: 1 }),
      order({ id: 2, action: 'SELL', pnlEur: 1, feeEur: 0.03 }),
    ])[0]!
    expect(metric.profit_factor).toBeNull()
  })

  it('merges SQL ledger aggregates with causally paired round-trip results', () => {
    const rows = [
      order({ id: 1, executionTimestamp: 900 }),
      order({ id: 2, action: 'SELL', executionTimestamp: 1800, pnlEur: 1 }),
    ]
    const summary = getStrategiesAnalyticsSummary({
      listPaperOrders: () => rows,
      paperOrderSignalAggregates: () => [
        {
          strategy_id: 'micro-trend-pullback',
          total_signals: 1,
          gate_rejections: 0,
          executed_buys: 1,
          executed_sells: 1,
          total_fees_eur: 0.06,
          net_pnl_eur: 1,
          avg_target_pct: 0.012,
        },
      ],
    })
    expect(summary[0]).toMatchObject({
      strategy_id: 'micro-trend-pullback',
      total_fees_eur: 0.06,
      net_pnl_eur: 1,
      avg_target_pct: 0.012,
      closed_trades: 1,
    })
    expect(summary[0]?.toll_ratio).toBeCloseTo((0.06 + 0.0305) / 1.0905)
  })

  it('returns open ledger rows without fabricating an exit or realized PnL', () => {
    const position = buildStrategyPositions(
      [order({ id: 12, executionTimestamp: 900 })],
      105,
      null,
      1800,
    )[0]!
    expect(position).toMatchObject({
      id: 12,
      status: 'OPEN',
      entry_time: new Date(900_000).toISOString(),
      exit_time: null,
      exit_price: null,
      net_pnl_eur: null,
      gross_pnl_eur: null,
      current_price: 105,
      holding_bars_15m: 1,
      exit_distance_pct: null,
      exit_distance_label: 'Sin datos',
    })
    expect(position.unrealized_net_pnl_eur).toBeCloseTo(1.42275)
  })

  it('recalculates open-position net floating PnL when the latest mark price changes', () => {
    const orders = [order({ id: 12, executionTimestamp: 900 })]
    const atEntry = buildStrategyPositions(orders, 100, null)[0]!
    const afterPriceRise = buildStrategyPositions(orders, 110, null)[0]!
    expect(atEntry.current_price).toBe(100)
    expect(afterPriceRise.current_price).toBe(110)
    expect(afterPriceRise.unrealized_net_pnl_eur!).toBeGreaterThan(
      atEntry.unrealized_net_pnl_eur!,
    )
    expect(afterPriceRise.unrealized_net_pnl_eur).toBeCloseTo(
      (30 / 100) * 110 * (1 - 0.001 - 0.0005) - (30 + 0.03),
    )
  })

  it('uses the PaperForward C28 regime through the neutral ATR band and abstains without it', () => {
    const build = (regime: MicroRegime) =>
      buildStrategyPositions(
        [openPosition('micro-regime-adapter')],
        100,
        readyFeatures({ atrPercentile50: 50 }),
        1800,
        regime,
      )[0]!
    expect(build('trend').exit_distance_pct).toBeCloseTo(1)
    expect(build('range').exit_distance_pct).toBeCloseTo(1)
    expect(build(null)).toMatchObject({
      exit_distance_pct: null,
      exit_distance_label: 'Sin datos',
    })
  })

  it('reports C25 and C26 triggered exits as immediate with zero non-negative distance', () => {
    const trend = buildStrategyPositions(
      [openPosition('micro-trend-pullback')],
      100,
      readyFeatures({ rsi14: 69 }),
      1800,
    )[0]!
    const reversion = buildStrategyPositions(
      [openPosition('micro-bollinger-reversion')],
      102,
      readyFeatures({ bollingerMid: 101 }),
      1800,
    )[0]!
    expect(trend).toMatchObject({
      exit_distance_pct: 0,
      exit_distance_label: 'Salida inmediata',
    })
    expect(reversion).toMatchObject({
      exit_distance_pct: 0,
      exit_distance_label: 'Salida inmediata',
    })
  })

  it('includes the C27 eight-bar stop at the latest closed bucket end', () => {
    const position = [openPosition('micro-donchian-breakout')]
    const features = readyFeatures({ donchianMid20: 95 })
    const oneBarEarly = buildStrategyPositions(
      position,
      100.4,
      features,
      7200,
    )[0]!
    const atEightBars = buildStrategyPositions(
      position,
      100.4,
      features,
      8100,
    )[0]!
    expect(oneBarEarly.exit_distance_pct).toBeGreaterThan(1)
    expect(atEightBars.exit_distance_pct).toBeCloseTo((0.1 / 100.4) * 100)
  })
})
