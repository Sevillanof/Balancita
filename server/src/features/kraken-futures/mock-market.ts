import { createHash } from 'node:crypto'
import { FuturesMarketStore } from './futures-market-store.ts'

const MINUTE = 60_000
const FIVE_MINUTES = 5 * MINUTE
const PRODUCT = 'PF_XBTUSD'

export interface MockMarketOptions {
  /** Close of the last candle; rounded down to a minute. */
  readonly endMs: number
  /** Closed 1m candles to seed (default 720 = 12 h). */
  readonly minutes?: number
}

interface Bar {
  readonly start: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

/** Deterministic random walk that alternates up-trend, down-trend and range stretches. */
export function mockBars(endMs: number, minutes: number): Bar[] {
  let seed = 20_261_007
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const last = endMs - (endMs % MINUTE)
  const bars: Bar[] = []
  let price = 84_000
  for (let index = 0; index < minutes; index += 1) {
    const drift = [18, -18, 0][Math.floor(index / 90) % 3]!
    const open = price
    const close = Math.round((open + drift + (random() - 0.5) * 120) * 10) / 10
    bars.push({
      start: last - (minutes - index) * MINUTE,
      open,
      high: Math.max(open, close) + Math.round(random() * 30),
      low: Math.min(open, close) - Math.round(random() * 30),
      close,
      volume: Math.round((1 + random() * 7) * 100) / 100,
    })
    price = close
  }
  return bars
}

function aggregate(bars: Bar[], start: number): Bar {
  const group = bars.filter((bar) => bar.start >= start && bar.start < start + FIVE_MINUTES)
  return {
    start,
    open: group[0]!.open,
    high: Math.max(...group.map((bar) => bar.high)),
    low: Math.min(...group.map((bar) => bar.low)),
    close: group.at(-1)!.close,
    volume: group.reduce((sum, bar) => sum + bar.volume, 0),
  }
}

/**
 * Writes a recorded-looking market into a new capture DB: observed and official
 * candles with the live process's `known_at` timing, and one ticker per
 * minute. Same shapes as capture A writes, so C and D can run over it unchanged.
 */
export function seedMockMarket(path: string, options: MockMarketOptions): { bars: number; lastBucket: number } {
  const bars = mockBars(options.endMs, options.minutes ?? 720)
  const store = new FuturesMarketStore(path)
  try {
    let serial = 0
    const official = (intervalMs: number, bar: Bar, receivedAtMs: number) => {
      serial += 1
      const candles = [
        {
          intervalMs,
          bucketStart: bar.start,
          open: String(bar.open),
          high: String(bar.high),
          low: String(bar.low),
          close: String(bar.close),
          volumeBtc: bar.volume.toFixed(2),
        },
      ]
      const rawResponse = JSON.stringify({ mock: serial, productId: PRODUCT, candles })
      store.appendOfficialCandles({
        productId: PRODUCT,
        intervalMs,
        fromMs: bar.start,
        toMs: bar.start + intervalMs,
        receivedAtMs,
        rawResponse,
        sha256: createHash('sha256').update(rawResponse, 'utf8').digest('hex'),
        candles,
      })
    }
    bars.forEach((bar, index) => {
      const closeAt = bar.start + MINUTE
      store.saveCandleRevision({
        id: `${PRODUCT}:${MINUTE}:${bar.start}`,
        intervalMs: MINUTE,
        bucketStart: bar.start,
        revision: 1,
        knownAt: closeAt + 1,
        closeAt,
        isClosed: true,
        coverage: 'observed_trades_only_no_gap_certification',
        open: String(bar.open),
        high: String(bar.high),
        low: String(bar.low),
        close: String(bar.close),
        volumeBtc: bar.volume.toFixed(2),
        tradeCount: 3,
        sourceHash: 'a'.repeat(64),
      })
      official(MINUTE, bar, closeAt + 5_000)
      if ((bar.start + MINUTE) % FIVE_MINUTES === 0)
        official(FIVE_MINUTES, aggregate(bars.slice(0, index + 1), bar.start + MINUTE - FIVE_MINUTES), closeAt + 5_000)
      const received = closeAt + 2_000
      store.append({
        type: 'ticker',
        productId: PRODUCT,
        seq: index + 1,
        epoch: 1,
        eventTime: received - 1,
        receivedAt: received,
        persistedAt: received,
        last: String(bar.close),
        bid: String(bar.close - 0.5),
        ask: String(bar.close + 0.5),
        mark: String(bar.close),
        suspended: false,
        funding: { status: 'unknown' },
        raw: { feed: 'ticker', bid_size: 5, ask_size: 5 },
      })
    })
    return { bars: bars.length, lastBucket: bars.at(-1)!.start }
  } finally {
    store.close()
  }
}
