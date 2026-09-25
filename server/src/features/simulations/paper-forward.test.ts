import { describe, expect, it, vi } from 'vitest'
import { makeCandle } from './paper-forward-test-helpers.ts'
import { PaperForwardService } from './paper-forward.ts'
import { MarketStore } from '../market-data/market-store.ts'
import {
  FAST_REPLAY_STRATEGIES,
  fastReplayCanEnter,
  fastReplayFeaturesAt,
  fastReplayStrategyFor,
  resample1mTo15m,
} from './fast-replay-engine.ts'
import {
  evaluateMicroTarget,
  initialMicroState,
  macroContextWhenReady,
} from './micro-strategy.ts'

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
      bollingerMid: 1_000,
      atr14: 0.1,
      priorAtrSma20: null,
      donchianHigh20: 1_000.1,
      donchianLow20: 999.9,
      donchianMid20: null,
      volume: 10,
      priorVolumeSma20: null,
      atrPercentile50: null,
      ready: true,
    }
    const macro = {
      ...features,
      atr14: 3.1,
      bollingerMid: 1_006.1,
      donchianHigh20: 1_006.1,
      donchianLow20: 1_000,
      ready: true,
    }
    const weakMacro = {
      ...macro,
      atr14: 0.1,
      bollingerMid: 1_000,
      donchianHigh20: 1_000.1,
      donchianLow20: 999.9,
    }
    for (const id of FAST_REPLAY_STRATEGIES)
      expect(
        fastReplayCanEnter(
          id,
          features,
          id === 'micro-regime-adapter' ? 'range' : null,
          macro,
        ),
      ).toBe(true)
    for (const id of FAST_REPLAY_STRATEGIES)
      expect(
        fastReplayCanEnter(
          id,
          {
            ...features,
            atr14: 10,
            bollingerMid: 2_000,
            donchianHigh20: 2_000,
            donchianLow20: 1,
          },
          id === 'micro-regime-adapter' ? 'range' : null,
          weakMacro,
        ),
      ).toBe(false)
    expect(fastReplayCanEnter('micro-trend-pullback', features, null)).toBe(
      false,
    )
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

  it('does not let an unready macro percentile select C28 or emit an entry', () => {
    const currentFeatures = {
      ema9: 12,
      ema21: 11,
      sma50: 10,
      rsi14: 30,
      close: 12,
      bollingerLower: 13,
      bollingerMid: 14,
      atr14: 1,
      priorAtrSma20: 2,
      donchianHigh20: 11,
      donchianLow20: 9,
      donchianMid20: 10,
      volume: 3,
      priorVolumeSma20: 2,
      atrPercentile50: 10,
      ready: true,
    }
    const macroFeatures = {
      ...currentFeatures,
      atrPercentile50: 90,
      ready: false,
    }
    const decision = evaluateMicroTarget(
      'regime-adapter',
      currentFeatures,
      initialMicroState(),
      macroContextWhenReady(macroFeatures),
    )

    expect(decision).toMatchObject({
      target: 'flat',
      abstained: true,
      state: { regime: null },
    })
  })

  it('requires C27 close to break the 15m high and applies the macro Gate', () => {
    const oneMinuteFeatures = {
      ema9: 12,
      ema21: 11,
      sma50: 10,
      rsi14: 30,
      close: 1_000,
      bollingerLower: 990,
      bollingerMid: 1_000,
      atr14: 1,
      priorAtrSma20: 2,
      donchianHigh20: 999,
      donchianLow20: 990,
      donchianMid20: 994.5,
      volume: 10,
      priorVolumeSma20: 2,
      atrPercentile50: 50,
      ready: true,
    }
    const macro = {
      ...oneMinuteFeatures,
      donchianHigh20: 1_001,
      donchianLow20: 990,
    }
    expect(
      evaluateMicroTarget(
        'donchian-breakout',
        oneMinuteFeatures,
        initialMicroState(),
        macroContextWhenReady(macro),
      ).target,
    ).toBe('flat')

    macro.donchianHigh20 = 999
    const context = macroContextWhenReady(macro)
    expect(
      evaluateMicroTarget(
        'donchian-breakout',
        oneMinuteFeatures,
        initialMicroState(),
        context,
      ).target,
    ).toBe('long')
    expect(
      fastReplayCanEnter(
        'micro-donchian-breakout',
        oneMinuteFeatures,
        null,
        macro,
      ),
    ).toBe(true)
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

  it('applies the C27 stop from the executed fill and sells at the next open', () => {
    const store = new MarketStore({ path: ':memory:' })
    const history = Array.from({ length: 55 }, (_, index) => {
      const base = makeCandle(index)
      return { ...base, open: 100, high: 101, low: 99, close: 100 }
    })
    store.insertOhlcCandles(history)
    const fillPrice = 100 * 1.0005
    store.insertPaperOrder({
      strategyId: 'micro-donchian-breakout',
      signalTimestamp: history[54]!.timestamp + 60,
      action: 'BUY',
      gatePassed: true,
      price: fillPrice,
      executionTimestamp: history[54]!.timestamp + 60,
      amountEur: 30,
      feeEur: 0.03,
      pnlEur: null,
      targetPct: 0.01,
    })
    const service = new PaperForwardService({ store })
    const exitCandle = {
      ...makeCandle(55),
      open: 90,
      high: 99,
      low: 98,
      close: 99,
    }
    service.processClosedCandle(exitCandle, 88)
    const sell = store.listPaperOrders().find((row) => row.action === 'SELL')
    expect(sell).toMatchObject({
      price: 88 * 0.9995,
      executionTimestamp: exitCandle.timestamp + 60,
    })
    store.close()
  })

  it('uses the completed 15m Donchian mid for PaperForward C27 stops', () => {
    const store = new MarketStore({ path: ':memory:' })
    const start = Math.floor(1_700_000_000 / 900) * 900
    const history = Array.from({ length: 1_200 }, (_, index) => {
      const candle = makeCandle(index)
      const recent = index >= 1_180
      return {
        ...candle,
        timestamp: start + index * 60,
        open: 100,
        high: recent ? 100.4 : 103,
        low: recent ? 99.6 : 99,
        close: 100,
        volume: 10,
      }
    })
    store.insertOhlcCandles(history)
    const exitCandle = {
      ...makeCandle(1_200),
      timestamp: start + 1_200 * 60,
      open: 100.4,
      high: 100.6,
      low: 100.3,
      close: 100.5,
      volume: 10,
    }
    const oneMinute = fastReplayFeaturesAt([...history.slice(-20), exitCandle])
    const macroCandles = resample1mTo15m(
      [...history, exitCandle],
      exitCandle.timestamp + 60,
    )
    expect(macroCandles.length).toBeGreaterThan(20)
    const macro = fastReplayFeaturesAt(macroCandles)
    expect(oneMinute.donchianMid20).toBe(100)
    expect(macro.donchianMid20).toBe(101)

    const positionTime = history[1_199]!.timestamp + 60
    store.insertPaperOrder({
      strategyId: 'micro-donchian-breakout',
      signalTimestamp: positionTime,
      action: 'BUY',
      gatePassed: true,
      price: 100,
      executionTimestamp: positionTime,
      amountEur: 30,
      feeEur: 0.03,
      pnlEur: null,
      targetPct: 0.01,
    })
    const service = new PaperForwardService({ store })
    service.processClosedCandle(exitCandle, 100.4)
    const sell = store.listPaperOrders().find((row) => row.action === 'SELL')
    expect(sell).toMatchObject({
      price: 100.4 * 0.9995,
      executionTimestamp: exitCandle.timestamp + 60,
    })
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

  it('loads bounded persisted 1m history for causal 15m macro warm-up', () => {
    const store = new MarketStore({ path: ':memory:' })
    const history = Array.from({ length: 1_200 }, (_, index) => {
      const candle = makeCandle(index)
      const range = 10 + (index % 7)
      return {
        ...candle,
        high: candle.close + range,
        low: candle.close - range,
        volume: 10,
      }
    })
    store.insertOhlcCandles(history)
    const query = vi.spyOn(store, 'latestContinuousOhlcCandles')
    const service = new PaperForwardService({ store })
    const next = makeCandle(1_200)
    service.processClosedCandle(next)
    expect(query).toHaveBeenCalled()
    expect(
      query.mock.calls.some(
        ([limit, cutoff]) =>
          limit >= 1_000 && cutoff === next.timestamp * 1_000,
      ),
    ).toBe(true)
    expect(service.status().candles_ready).toBe(true)
    store.close()
  })

  it('does not emit a C27 breakout without warmed-up 15m Donchian features', () => {
    const store = new MarketStore({ path: ':memory:' })
    const service = new PaperForwardService({ store })
    for (let index = 0; index < 54; index += 1) {
      const candle = makeCandle(index)
      service.processClosedCandle({
        ...candle,
        open: 20_000,
        high: 20_010,
        low: 19_990,
        close: 20_000,
        volume: 10,
      })
    }
    const signal = makeCandle(54)
    service.processClosedCandle({
      ...signal,
      open: 20_000,
      high: 20_012,
      low: 19_999,
      close: 20_011,
      volume: 100,
    })
    expect(
      store
        .listPaperOrders()
        .filter(
          (order) =>
            order.strategyId === 'micro-donchian-breakout' &&
            order.signalTimestamp === signal.timestamp + 60,
        ),
    ).toHaveLength(0)
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
