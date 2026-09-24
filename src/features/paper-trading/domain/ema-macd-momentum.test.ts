import { describe, expect, it } from 'vitest'
import {
  aggregateClosed15mCandles,
  evaluateMomentumSignal,
  calculateMomentumIndicators,
  largestAffordableQuantity,
} from './ema-macd-momentum'
import type { Candle } from '../../market-data/domain/market-data.ts'
import {
  moneyAdd,
  moneyFromString,
  moneyMul,
  moneyCompare,
} from '../../../shared/finance/money.ts'

function candles(
  count: number,
  closeAt: (index: number) => number = () => 100,
): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index)
    return {
      time: new Date(index * 900_000).toISOString(),
      open: close,
      high: close,
      low: close,
      close,
      volume: index + 1,
      isClosed: true,
    }
  })
}

describe('EMA + MACD Momentum Filter v1', () => {
  it('aggregates only complete closed 15m intervals without inventing volume', () => {
    const minutes = Array.from({ length: 16 }, (_, index) => ({
      time: new Date(index * 60_000).toISOString(),
      open: index + 1,
      high: index + 1,
      low: index,
      close: index + 1,
      volume: 2,
      ...(index === 15 ? { isClosed: false } : { isClosed: true }),
    }))
    expect(aggregateClosed15mCandles(minutes)).toEqual([
      {
        time: new Date(0).toISOString(),
        open: 1,
        high: 15,
        low: 0,
        close: 15,
        volume: 30,
        isClosed: true,
      },
    ])
    expect(aggregateClosed15mCandles(minutes.slice(1, 15))).toEqual([])
  })

  it('seeds EMAs with an N-value SMA and remains not ready until all windows warm up', () => {
    const values = calculateMomentumIndicators(candles(33))
    expect(values.ready).toBe(false)
    expect(values.ema8).toBe(100)
    expect(values.ema21).toBe(100)
    expect(values.macd).toBeNull()
    expect(values.volumeSma20).toBe(23.5)
  })

  it('returns finite EMA and MACD values after the 26+9 warmup without an off-by-one', () => {
    const input = candles(34, (index) => index + 1)
    const before = calculateMomentumIndicators(input.slice(0, 33))
    const ready = calculateMomentumIndicators(input)
    expect(before.macd).toBeNull()
    expect(ready.ready).toBe(true)
    expect(ready.macd?.line).toBeCloseTo(7, 8)
    expect(ready.macd?.signal).toBeCloseTo(7, 8)
    expect(ready.macd?.histogram).toBeCloseTo(0, 8)
    expect(
      Object.values(ready)
        .filter((value) => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true)
  })

  it('requires a bullish trend, positive MACD/histogram, volume expansion and flat exposure to enter', () => {
    const history = candles(34, (index) => 100 + index).map(
      (candle, index) => ({ ...candle, volume: index === 33 ? 100 : 10 }),
    )
    const indicators = {
      ready: true,
      ema8: 120,
      ema21: 110,
      macd: { line: 2, signal: 1, histogram: 1 },
      volumeSma20: 14.5,
    }
    expect(evaluateMomentumSignal(history, indicators, 'flat')).toBe('buy')
    expect(evaluateMomentumSignal(history, indicators, 'long')).toBeNull()
    const lowVolume = history.map((candle) => ({ ...candle, volume: 1 }))
    expect(
      evaluateMomentumSignal(
        lowVolume,
        calculateMomentumIndicators(lowVolume),
        'flat',
      ),
    ).toBeNull()
  })

  it('exits only on a bearish EMA or MACD cross and only when already long', () => {
    const history = candles(34)
    const base = {
      ready: true,
      ema8: 90,
      ema21: 100,
      macd: { line: 0, signal: 1, histogram: -1 },
      volumeSma20: 10,
    }
    const emaCross = { ...base, previous: { ...base, ema8: 101, ema21: 100 } }
    expect(evaluateMomentumSignal(history, emaCross, 'long')).toBe('sell')
    expect(evaluateMomentumSignal(history, emaCross, 'flat')).toBeNull()

    const macdCross = {
      ...base,
      ema8: 110,
      ema21: 100,
      previous: {
        ...base,
        ema8: 110,
        ema21: 100,
        macd: { line: 2, signal: 1, histogram: 1 },
      },
    }
    expect(evaluateMomentumSignal(history, macdCross, 'long')).toBe('sell')
  })

  it('sizes a buy with fixed-scale money so notional plus the simulated fee fits cash', () => {
    const cash = moneyFromString('1000')
    const price = moneyFromString('100')
    const fee = moneyFromString('0.00075')
    const quantity = largestAffordableQuantity(cash, price, fee)
    const total = moneyAdd(
      moneyMul(quantity, price),
      moneyMul(moneyMul(quantity, price), fee),
    )
    const nextUnit = { units: quantity.units + 1n }
    const nextTotal = moneyAdd(
      moneyMul(nextUnit, price),
      moneyMul(moneyMul(nextUnit, price), fee),
    )
    expect(moneyCompare(total, cash)).toBeLessThanOrEqual(0)
    expect(moneyCompare(nextTotal, cash)).toBeGreaterThan(0)
  })
})
