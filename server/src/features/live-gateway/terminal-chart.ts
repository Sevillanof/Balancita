import type { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import { FUTURES_PRODUCT } from '../kraken-futures/futures-market.ts'

type Row = Record<string, unknown>

/** Timeframes the terminal chart can ask for, smallest first. */
export const CHART_INTERVALS_MS = [
  60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000,
] as const
const CANDLES_SERVED = 500
/** Analytics source per timeframe: minutes up to 15m, hours above. */
const MINUTE = 60_000
const HOUR = 3_600_000

export interface ChartCandle {
  time_ms: number
  open: string
  high: string
  low: string
  close: string
  volume_btc: string
  closed: boolean
}

/** Aggregated order flow, open interest and positioning of one bucket. */
export interface ChartFlow {
  time_ms: number
  buy_volume: number | null
  sell_volume: number | null
  liquidation_volume: number | null
  open_interest: number | null
  long_percent: number | null
  top_long_percent: number | null
  volatility: number | null
}

/**
 * Every field of the latest public ticker that a trader reads: 24 h stats,
 * mark/index/premium, best bid/ask with sizes, open interest and funding.
 * Taken from the stored raw provider message; numbers as Kraken sent them.
 */
export interface TickerStats {
  event_time: number | null
  received_at: number | null
  last: number | null
  mark: number | null
  index: number | null
  premium: number | null
  bid: number | null
  ask: number | null
  bid_size: number | null
  ask_size: number | null
  spread: number | null
  open_24h: number | null
  high_24h: number | null
  low_24h: number | null
  change_24h_pct: number | null
  volume_24h_base: number | null
  volume_24h_quote: number | null
  open_interest: number | null
  /** USD per BTC per hour (Kraken `funding_rate`). */
  funding_rate: number | null
  funding_rate_prediction: number | null
  /** Fraction of the price per hour (Kraken `relative_funding_rate`). */
  relative_funding_rate: number | null
  relative_funding_rate_prediction: number | null
  next_funding_time_ms: number | null
  suspended: boolean | null
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' &&
        /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
      ? Number(value)
      : null

/** Ticker stats from a stored ticker event (its `rawJson` provider message). */
export function tickerStats(event: Row): TickerStats | null {
  if (event.type !== 'ticker' || typeof event.rawJson !== 'string') return null
  let raw: Row
  try {
    const parsed: unknown = JSON.parse(event.rawJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null
    raw = parsed as Row
  } catch {
    return null
  }
  const bid = finite(raw.bid)
  const ask = finite(raw.ask)
  const next = finite(raw.next_funding_rate_time)
  return {
    event_time: finite(event.eventTime),
    received_at: finite(event.receivedAt),
    last: finite(raw.last),
    mark: finite(raw.markPrice),
    index: finite(raw.index),
    premium: finite(raw.premium),
    bid,
    ask,
    bid_size: finite(raw.bid_size),
    ask_size: finite(raw.ask_size),
    spread: bid !== null && ask !== null ? ask - bid : null,
    open_24h: finite(raw.open),
    high_24h: finite(raw.high),
    low_24h: finite(raw.low),
    change_24h_pct: finite(raw.change),
    volume_24h_base: finite(raw.volume),
    volume_24h_quote: finite(raw.volumeQuote),
    open_interest: finite(raw.openInterest),
    funding_rate: finite(raw.funding_rate),
    funding_rate_prediction: finite(raw.funding_rate_prediction),
    relative_funding_rate: finite(raw.relative_funding_rate),
    relative_funding_rate_prediction: finite(
      raw.relative_funding_rate_prediction,
    ),
    next_funding_time_ms:
      next !== null && Number.isSafeInteger(next) ? next : null,
    suspended: typeof raw.suspended === 'boolean' ? raw.suspended : null,
  }
}

/** Drops binary floating-point noise from a sum of decimal values. */
const round = (value: number) => Math.round(value * 1e8) / 1e8

/** Folds candles (any finer interval, ascending) into `intervalMs` buckets. */
export function aggregateCandles(
  candles: readonly ChartCandle[],
  intervalMs: number,
): ChartCandle[] {
  const out: ChartCandle[] = []
  for (const candle of candles) {
    const bucket = Math.floor(candle.time_ms / intervalMs) * intervalMs
    const last = out.at(-1)
    if (last && last.time_ms === bucket) {
      last.high = String(Math.max(Number(last.high), Number(candle.high)))
      last.low = String(Math.min(Number(last.low), Number(candle.low)))
      last.close = candle.close
      last.volume_btc = String(
        round(Number(last.volume_btc) + Number(candle.volume_btc)),
      )
      last.closed = false
    } else
      out.push({
        ...candle,
        time_ms: bucket,
        // A bucket built from finer candles is provisional until Kraken's own
        // candle of this timeframe lands.
        closed: false,
      })
  }
  return out
}

function officialChartCandles(
  store: FuturesMarketStore,
  intervalMs: number,
  limit: number,
  productId: string,
): ChartCandle[] {
  return store
    .officialCandlesAsOf(productId, intervalMs, Number.MAX_SAFE_INTEGER, limit)
    .map((candle) => ({
      time_ms: candle.bucketStart,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume_btc: candle.volumeBtc,
      closed: true,
    }))
}

/**
 * Candles of one timeframe: Kraken's official closed candles, then the
 * buckets Kraken has not published yet, built from the next finer official
 * timeframes and finally the live 1m candles (closed and forming).
 */
export function chartCandles(
  store: FuturesMarketStore,
  intervalMs: number,
  minuteCandles: readonly ChartCandle[],
  now: number,
  productId: string = FUTURES_PRODUCT,
): ChartCandle[] {
  if (intervalMs === MINUTE) return minuteCandles.slice(-CANDLES_SERVED)
  const official = officialChartCandles(
    store,
    intervalMs,
    CANDLES_SERVED,
    productId,
  )
  let cursor =
    official.length > 0 ? official.at(-1)!.time_ms + intervalMs : undefined
  const finer: ChartCandle[] = []
  for (const step of [...CHART_INTERVALS_MS].reverse()) {
    if (step >= intervalMs || step === MINUTE) continue
    if (cursor === undefined) break
    const wanted = Math.min(5_000, Math.ceil((now - cursor) / step) + 2)
    if (wanted < 1) break
    const pieces = officialChartCandles(store, step, wanted, productId).filter(
      (candle) => candle.time_ms >= cursor!,
    )
    // Only a contiguous run from the cursor is safe to fold in.
    for (const piece of pieces) {
      if (piece.time_ms !== cursor) break
      finer.push(piece)
      cursor += step
    }
  }
  const minutes =
    cursor === undefined
      ? official.length > 0
        ? []
        : minuteCandles
      : minuteCandles.filter((candle) => candle.time_ms >= cursor!)
  const provisional = aggregateCandles([...finer, ...minutes], intervalMs)
  const last = official.at(-1)?.time_ms ?? -1
  return [
    ...official,
    ...provisional.filter((candle) => candle.time_ms > last),
  ].slice(-CANDLES_SERVED)
}

const num = (values: Record<string, string> | undefined, key: string) =>
  values === undefined ? null : finite(values[key])

/**
 * Kraken analytics folded into the chart's buckets: buy/sell and liquidated
 * volume add up; open interest, positioning and volatility take the bucket's
 * last value.
 */
export function chartFlow(
  store: FuturesMarketStore,
  intervalMs: number,
  fromMs: number,
  productId: string = FUTURES_PRODUCT,
): ChartFlow[] {
  const source = intervalMs <= 900_000 ? MINUTE : HOUR
  const read = (metric: string) =>
    store.analyticsSince(productId, metric, source, fromMs, 5_000)
  const buckets = new Map<number, ChartFlow>()
  const at = (time: number): ChartFlow => {
    const bucket = Math.floor(time / intervalMs) * intervalMs
    let flow = buckets.get(bucket)
    if (!flow) {
      flow = {
        time_ms: bucket,
        buy_volume: null,
        sell_volume: null,
        liquidation_volume: null,
        open_interest: null,
        long_percent: null,
        top_long_percent: null,
        volatility: null,
      }
      buckets.set(bucket, flow)
    }
    return flow
  }
  const add = (left: number | null, right: number | null) =>
    right === null ? left : round((left ?? 0) + right)
  for (const point of read('cvd')) {
    const flow = at(point.bucketStart)
    flow.buy_volume = add(flow.buy_volume, num(point.values, 'buy_volume'))
    flow.sell_volume = add(flow.sell_volume, num(point.values, 'sell_volume'))
  }
  for (const point of read('liquidation-volume')) {
    const flow = at(point.bucketStart)
    flow.liquidation_volume = add(
      flow.liquidation_volume,
      num(point.values, 'value'),
    )
  }
  const last = (
    metric: string,
    key: string,
    field: 'open_interest' | 'long_percent' | 'top_long_percent' | 'volatility',
  ) => {
    for (const point of read(metric)) {
      const value = num(point.values, key)
      if (value !== null) at(point.bucketStart)[field] = value
    }
  }
  last('open-interest', 'close', 'open_interest')
  last('long-short-info', 'longPercent', 'long_percent')
  last('top-traders', 'top20Percent.longPercent', 'top_long_percent')
  last('rolling-volatility', 'value', 'volatility')
  return [...buckets.values()].sort(
    (left, right) => left.time_ms - right.time_ms,
  )
}

/** Latest order book depth snapshot: liquidity bands and slippage per side. */
export function chartDepth(
  store: FuturesMarketStore,
  now: number,
  productId: string = FUTURES_PRODUCT,
): { time_ms: number; bid: Row; ask: Row } | null {
  const point = store
    .analyticsSince(productId, 'orderbook', MINUTE, now - HOUR, 5_000)
    .at(-1)
  if (!point) return null
  const side = (name: 'bid' | 'ask') =>
    Object.fromEntries(
      Object.entries(point.values)
        .filter(([key]) => key.startsWith(`${name}.`))
        .map(([key, value]) => [key.slice(name.length + 1), finite(value)]),
    )
  return { time_ms: point.bucketStart, bid: side('bid'), ask: side('ask') }
}
