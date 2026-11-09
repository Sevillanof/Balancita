import { describe, expect, it } from 'vitest'
import type { QwenAccountResponse } from './qwen-decisions.ts'
import {
  createEthPriceLookup,
  withEthPrices,
  type EthCandle,
} from './qwen-account-eth.ts'

const MIN = 60_000
const T0 = 1_793_400_000_000 - (1_793_400_000_000 % MIN)

/** Closed 1m candles, ascending, as Kraken's history serves them. */
const candles: EthCandle[] = [
  { time_ms: T0, close: '2000' },
  { time_ms: T0 + MIN, close: '2010.5' },
  { time_ms: T0 + 2 * MIN, close: '1900' },
]
const before = (beforeMs: number, limit: number) =>
  candles.filter((c) => c.time_ms < beforeMs).slice(-limit)

describe('createEthPriceLookup', () => {
  it('reads the close of the last candle that had finished by that moment', () => {
    const priceAt = createEthPriceLookup(before)
    expect(priceAt(T0 + MIN)).toBe(2000)
    expect(priceAt(T0 + MIN + 30_000)).toBe(2000)
    expect(priceAt(T0 + 2 * MIN)).toBe(2010.5)
    expect(priceAt(T0 + 3 * MIN)).toBe(1900)
  })

  it('answers null rather than guess: no candle, a stale one, or a broken close', () => {
    expect(createEthPriceLookup(before)(T0)).toBeNull()
    expect(createEthPriceLookup(before)(T0 + 3 * MIN + 6 * MIN)).toBeNull()
    expect(
      createEthPriceLookup(() => [{ time_ms: T0, close: 'NaN' }])(T0 + MIN),
    ).toBeNull()
    expect(
      createEthPriceLookup(() => [{ time_ms: T0, close: '0' }])(T0 + MIN),
    ).toBeNull()
    expect(
      createEthPriceLookup(() => {
        throw new Error('store gone')
      })(T0 + MIN),
    ).toBeNull()
  })

  it('does not read twice for an old moment, but retries what was unknown', () => {
    let reads = 0
    const old = 1_000_000_000_000
    const priceAt = createEthPriceLookup(
      () => {
        reads += 1
        return [{ time_ms: old - MIN, close: '2000' }]
      },
      { now: () => old + 3_600_000 },
    )
    expect(priceAt(old)).toBe(2000)
    expect(priceAt(old)).toBe(2000)
    expect(reads).toBe(1)
    let empty = 0
    const missing = createEthPriceLookup(
      () => {
        empty += 1
        return []
      },
      { now: () => old + 3_600_000 },
    )
    missing(old)
    missing(old)
    expect(empty).toBe(2)
  })
})

const base = {
  status: 'ok',
  start_usd: 1000,
  start_ms: T0 + MIN,
  balance_usd: 990,
  realized_usd: -10,
  open_usd: 0,
  open_count: 0,
  funding_incomplete: false,
} as const
const step = (product: string, exit_ms: number, exit_price: number | null) => ({
  product,
  trade_no: 1,
  side: 'LONG' as const,
  exit_ms,
  net_usd: -10,
  balance_usd: 990,
  entry_ms: T0,
  entry_price: null,
  exit_price,
  closed_by: null,
  exit_reason: null,
  max_hold_ms: null,
})

describe('withEthPrices', () => {
  const priceAt = createEthPriceLookup(before)
  it('prices the start, now, and each close: the ETH exit price for ETH trades, the candle for the rest', () => {
    const account: QwenAccountResponse = {
      ...base,
      steps: [
        step('PF_ETHUSD', T0 + 2 * MIN, 2020.25),
        step('PF_XBTUSD', T0 + 3 * MIN, 91_000),
      ],
    }
    const out = withEthPrices(account, priceAt, T0 + 3 * MIN)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.eth_start_price).toBe(2000)
    expect(out.eth_now_price).toBe(1900)
    expect(out.as_of_ms).toBe(T0 + 3 * MIN)
    expect(out.steps.map((s) => s.eth_price)).toEqual([2020.25, 1900])
  })

  it('leaves null where nothing is known and keeps the rest of the account', () => {
    const account: QwenAccountResponse = {
      ...base,
      start_ms: null,
      steps: [step('PF_ETHUSD', T0 - 10 * MIN, null)],
    }
    const out = withEthPrices(account, priceAt, T0 + 3 * MIN)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.eth_start_price).toBeNull()
    expect(out.steps[0]!.eth_price).toBeNull()
    expect(out.balance_usd).toBe(990)
  })

  it('passes an off or error answer through untouched', () => {
    const off: QwenAccountResponse = { status: 'off', reason: 'x' }
    expect(withEthPrices(off, priceAt, T0)).toBe(off)
  })
})
