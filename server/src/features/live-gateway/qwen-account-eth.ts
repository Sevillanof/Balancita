import type { QwenAccountResponse } from './qwen-decisions.ts'

/** The product the Terminal's balance is compared against: buying it at the start and holding. */
export const ETH_PRODUCT = 'PF_ETHUSD'

const MINUTE = 60_000
/** A price older than this at the asked moment is a hole in the data, not a price. */
const MAX_PRICE_AGE_MS = 5 * MINUTE
/** Candles older than this are final: their answer is kept. */
const SETTLED_MS = 10 * MINUTE

export interface EthCandle {
  readonly time_ms: number
  readonly close: string
}

/** Closed 1 m candles of PF_ETHUSD that started before `beforeMs`, ascending, at most `limit`. */
export type EthCandlesBefore = (
  beforeMs: number,
  limit: number,
) => readonly EthCandle[]

/** ETH price (USD) at a moment, or null when Kraken's candles do not cover it. */
export type EthPriceAt = (ms: number) => number | null

/**
 * The ETH price at a moment: the close of the last 1 m candle that had finished
 * by then (so never a price from the future). Null when there is no such candle,
 * it is more than five minutes old, or its close is not a positive number.
 */
export function createEthPriceLookup(
  candlesBefore: EthCandlesBefore,
  options: { readonly now?: () => number } = {},
): EthPriceAt {
  const now = options.now ?? Date.now
  const settled = new Map<number, number>()
  return (ms) => {
    const cached = settled.get(ms)
    if (cached !== undefined) return cached
    let price: number | null = null
    try {
      const candle = candlesBefore(Math.floor(ms / MINUTE) * MINUTE, 1).at(-1)
      const close = candle ? Number(candle.close) : Number.NaN
      if (
        candle &&
        Number.isFinite(close) &&
        close > 0 &&
        ms - (candle.time_ms + MINUTE) <= MAX_PRICE_AGE_MS
      )
        price = close
    } catch {
      price = null
    }
    if (price !== null && now() - ms > SETTLED_MS) settled.set(ms, price)
    return price
  }
}

/**
 * The account with the ETH prices the comparison needs, additively: at its
 * start, now, and at each close (the exit price of an ETH trade, otherwise the
 * candle at that time). Anything unknown stays null: no price is ever guessed.
 */
export function withEthPrices(
  account: QwenAccountResponse,
  priceAt: EthPriceAt,
  nowMs: number,
): QwenAccountResponse {
  if (account.status !== 'ok') return account
  return {
    ...account,
    as_of_ms: nowMs,
    eth_start_price:
      account.start_ms === null ? null : priceAt(account.start_ms),
    eth_now_price: priceAt(nowMs),
    steps: account.steps.map((step) => ({
      ...step,
      eth_price:
        step.product === ETH_PRODUCT &&
        step.exit_price !== null &&
        step.exit_price > 0
          ? step.exit_price
          : priceAt(step.exit_ms),
    })),
  }
}
