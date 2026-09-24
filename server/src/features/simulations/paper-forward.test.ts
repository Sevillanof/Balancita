import { describe, expect, it } from 'vitest'
import { makeCandle } from './paper-forward-test-helpers.ts'
import { PaperForwardService } from './paper-forward.ts'
import { MarketStore } from '../market-data/market-store.ts'
import {
  FAST_REPLAY_STRATEGIES,
  fastReplayCanEnter,
  fastReplayFeaturesAt,
  fastReplayStrategyFor,
} from './fast-replay-engine.ts'
import { evaluateMicroTarget, initialMicroState } from './micro-strategy.ts'

describe('PaperForwardService', () => {
  it('starts with the shared ten-thousand-euro account and empty ledger', () => {
    const store = new MarketStore({ path: ':memory:' })
    const status = new PaperForwardService({ store }).status(false)
    expect(status).toMatchObject({
      enabled: false,
      account: {
        balance_eur: 10_000,
        btc_balance: 0,
        total_equity_eur: 10_000,
      },
      active_positions: [],
      execution_summary: {
        total_signals: 0,
        gate_rejections: 0,
        executed_trades: 0,
        closed_pnl_eur: 0,
      },
    })
    store.close()
  })

  it('uses the identical 0.006 projected-target gate for all four candidates', () => {
    const features = {
      ema9: null,
      ema21: null,
      sma50: null,
      rsi14: null,
      close: 1_000,
      bollingerLower: null,
      bollingerMid: 1_006.1,
      atr14: 3.1,
      priorAtrSma20: null,
      donchianHigh20: 1_006.1,
      donchianLow20: 1_000,
      donchianMid20: null,
      volume: 10,
      priorVolumeSma20: null,
      atrPercentile50: null,
      ready: true,
    }
    for (const id of FAST_REPLAY_STRATEGIES)
      expect(
        fastReplayCanEnter(
          id,
          features,
          id === 'micro-regime-adapter' ? 'range' : null,
        ),
      ).toBe(true)
    expect(FAST_REPLAY_STRATEGIES.map(fastReplayStrategyFor)).toEqual([
      'trend-pullback',
      'bollinger-reversion',
      'donchian-breakout',
      'regime-adapter',
    ])
  })

  it('maps all registered candidates to their existing raw-entry target rules', () => {
    const common = {
      ema9: 102,
      ema21: 101,
      sma50: 97,
      rsi14: 30,
      close: 98,
      bollingerLower: 99,
      bollingerMid: 100,
      atr14: 1,
      priorAtrSma20: 2,
      donchianHigh20: 97,
      donchianLow20: 90,
      donchianMid20: 93.5,
      volume: 20,
      priorVolumeSma20: 10,
      atrPercentile50: 80,
      ready: true,
    }
    for (const id of FAST_REPLAY_STRATEGIES)
      expect(
        evaluateMicroTarget(
          fastReplayStrategyFor(id),
          common,
          initialMicroState(),
        ).target,
        id,
      ).toBe('long')
  })

  it('derives shared-account balance, open position quantity, fees and closed P&L from ledger rows', () => {
    const store = new MarketStore({ path: ':memory:' })
    const buyPrice = 20_010
    const sellPrice = 21_000
    const quantity = 30 / buyPrice
    store.insertPaperOrder({
      strategyId: 'micro-trend-pullback',
      signalTimestamp: 100,
      action: 'BUY',
      gatePassed: true,
      price: buyPrice,
      executionTimestamp: 100,
      amountEur: 30,
      feeEur: 0.03,
      pnlEur: null,
      targetPct: 0.01,
    })
    const service = new PaperForwardService({ store })
    expect(service.status().account).toMatchObject({
      balance_eur: 9_969.97,
      btc_balance: quantity,
    })
    expect(service.status().active_positions[0]?.open_time).toBe(
      new Date(100_000).toISOString(),
    )
    store.insertPaperOrder({
      strategyId: 'micro-trend-pullback',
      signalTimestamp: 160,
      action: 'SELL',
      gatePassed: true,
      price: sellPrice,
      executionTimestamp: 160,
      amountEur: 30,
      feeEur: quantity * sellPrice * 0.001,
      pnlEur: quantity * sellPrice - quantity * sellPrice * 0.001 - 30.03,
      targetPct: 0,
    })
    const closed = service.status()
    expect(closed.account.btc_balance).toBe(0)
    expect(closed.execution_summary).toMatchObject({
      total_signals: 2,
      executed_trades: 2,
    })
    expect(closed.execution_summary.closed_pnl_eur).toBeCloseTo(
      quantity * sellPrice - quantity * sellPrice * 0.001 - 30.03,
    )
    store.close()
  })

  it('keeps a restarted regime-adapter position open while its regime is neutral and abstained', () => {
    const store = new MarketStore({ path: ':memory:' })
    const history = Array.from({ length: 55 }, (_, index) => {
      const base = makeCandle(index)
      const price = 20_000
      const range = 1 + (index % 10)
      return {
        ...base,
        open: price,
        high: price + range,
        low: price - range,
        close: price,
      }
    })
    store.insertOhlcCandles(history)
    store.insertPaperOrder({
      strategyId: 'micro-regime-adapter',
      signalTimestamp: history[54]!.timestamp + 60,
      action: 'BUY',
      gatePassed: true,
      price: 20_010,
      executionTimestamp: history[54]!.timestamp + 60,
      amountEur: 30,
      feeEur: 0.03,
      pnlEur: null,
      targetPct: 0.01,
    })
    const latest = {
      ...history[54]!,
      timestamp: history[54]!.timestamp + 60,
      high: 20_007,
      low: 19_993,
    }
    expect(
      fastReplayFeaturesAt([...history, latest]).atrPercentile50,
    ).toBeGreaterThanOrEqual(40)
    expect(
      fastReplayFeaturesAt([...history, latest]).atrPercentile50,
    ).toBeLessThanOrEqual(60)
    const service = new PaperForwardService({ store })
    service.processClosedCandle(latest, 20_000)
    expect(service.status().active_positions).toHaveLength(1)
    expect(
      store.listPaperOrders().filter((row) => row.action === 'SELL'),
    ).toHaveLength(0)
    store.close()
  })

  it('waits for 55 continuous closed candles and persists no row from snapshots', () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    for (let index = 0; index < 54; index += 1)
      service.processClosedCandle(makeCandle(index))
    expect(service.status().execution_summary.total_signals).toBe(0)
    expect(store.listPaperOrders()).toHaveLength(0)
    service.processClosedCandle(makeCandle(54))
    expect(service.status().candles_ready).toBe(true)
    store.close()
  })

  it('does not claim stored historical OHLC was processed by a fresh paper service', () => {
    const store = new MarketStore({ path: ':memory:' })
    for (let index = 0; index < 55; index += 1)
      store.insertOhlcCandles([makeCandle(index)])
    const service = new PaperForwardService({ store })
    expect(service.status().last_processed_event_time).toBeNull()
    expect(service.status().candles_ready).toBe(true)
    const next = makeCandle(55)
    service.processClosedCandle(next)
    expect(service.status().last_processed_event_time).toBe(
      next.timestamp * 1000,
    )
    store.close()
  })

  it('ignores discontinuous data and restarts warm-up at the gap', () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    for (let index = 0; index < 55; index += 1)
      service.processClosedCandle(makeCandle(index))
    service.processClosedCandle(makeCandle(57), 20_000)
    expect(service.status().candles_ready).toBe(false)
    expect(service.status().execution_summary.total_signals).toBe(0)
    expect(store.listPaperOrders()).toHaveLength(0)
    store.close()
  })

  it('uses REST-refilled SQLite history for the next decision after a stream gap', () => {
    const store = new MarketStore({ path: ':memory:' })
    const history = Array.from({ length: 55 }, (_, index) => makeCandle(index))
    store.insertOhlcCandles(history.slice(0, 54))
    const service = new PaperForwardService({ store })

    service.processClosedCandle(makeCandle(55))
    expect(service.status().candles_ready).toBe(false)
    store.insertOhlcCandles([history[54]!])
    service.processClosedCandle(makeCandle(56))

    expect(service.status().candles_ready).toBe(true)
    store.close()
  })

  it('does not evaluate duplicate closed timestamps', () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    for (let index = 0; index < 55; index += 1)
      service.processClosedCandle(makeCandle(index))
    const repeated = makeCandle(54)
    service.processClosedCandle(repeated, 20_000)
    expect(service.status().last_processed_event_time).toBe(
      makeCandle(54).timestamp * 1000,
    )
    expect(store.listPaperOrders()).toHaveLength(0)
    store.close()
  })
})
