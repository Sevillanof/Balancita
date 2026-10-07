/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON assertions */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import { parseAnalytics } from '../kraken-futures/market-analytics.ts'
import { buildLiveGateway } from './gateway.ts'
import { aggregateCandles, tickerStats } from './terminal-chart.ts'

const M = 60_000
const H = 60 * M
// A day boundary, so every timeframe is aligned at BASE.
const BASE = 1_791_331_200_000
const dirs: string[] = []
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-chart-'))
  dirs.push(dir)
  return join(dir, 'market.sqlite')
}

let serial = 0
function saveOfficial(
  store: FuturesMarketStore,
  intervalMs: number,
  starts: number[],
  close = '100',
): void {
  serial += 1
  const candles = starts.map((bucketStart) => ({
    intervalMs,
    bucketStart,
    open: '100',
    high: '110',
    low: '90',
    close,
    volumeBtc: '2',
  }))
  const rawResponse = JSON.stringify({ serial, candles })
  store.appendOfficialCandles({
    productId: 'PF_XBTUSD',
    intervalMs,
    fromMs: BASE,
    toMs: BASE + 10 * H,
    receivedAtMs: BASE + 10 * H,
    rawResponse,
    sha256: createHash('sha256').update(rawResponse, 'utf8').digest('hex'),
    candles,
  })
}

function saveAnalytics(
  store: FuturesMarketStore,
  metric: Parameters<typeof parseAnalytics>[1]['metric'],
  starts: number[],
  data: unknown,
  intervalMs = M,
): void {
  store.appendAnalytics(
    parseAnalytics(
      JSON.stringify({
        result: { timestamp: starts.map((time) => time / 1000), data },
        errors: [],
      }),
      {
        productId: 'PF_XBTUSD',
        metric,
        intervalMs,
        fromMs: BASE,
        receivedAtMs: BASE + 10 * H,
      },
    ),
  )
}

const rawTicker = {
  time: BASE + 3 * H,
  product_id: 'PF_XBTUSD',
  funding_rate: 0.4662576117027781,
  funding_rate_prediction: 0.6279870261864448,
  relative_funding_rate: 5.537029166667e-6,
  relative_funding_rate_prediction: 7.452941666667e-6,
  next_funding_rate_time: BASE + 4 * H,
  premium: 0.0,
  feed: 'ticker',
  bid: 84226.0,
  ask: 84227.0,
  bid_size: 0.1591,
  ask_size: 0.0302,
  volume: 4304.9163,
  index: 84222.33,
  last: 84228.0,
  change: -1.37,
  suspended: false,
  openInterest: 2222.6546,
  markPrice: 84224.74741913384,
  volumeQuote: 367541241.6659,
  open: 85400.0,
  high: 86711.0,
  low: 83412.0,
}

describe('terminal chart series', () => {
  it('reads every trader-facing ticker field from the raw provider message', () => {
    const stats = tickerStats({
      type: 'ticker',
      eventTime: BASE,
      receivedAt: BASE + 5,
      rawJson: JSON.stringify(rawTicker),
    })!
    expect(stats).toMatchObject({
      last: 84228,
      mark: 84224.74741913384,
      index: 84222.33,
      bid: 84226,
      ask: 84227,
      spread: 1,
      bid_size: 0.1591,
      volume_24h_base: 4304.9163,
      volume_24h_quote: 367541241.6659,
      high_24h: 86711,
      low_24h: 83412,
      change_24h_pct: -1.37,
      open_interest: 2222.6546,
      relative_funding_rate: 5.537029166667e-6,
      next_funding_time_ms: BASE + 4 * H,
      suspended: false,
    })
    expect(tickerStats({ type: 'trade', rawJson: '{}' })).toBeNull()
    expect(tickerStats({ type: 'ticker', rawJson: 'nope' })).toBeNull()
  })

  it('folds finer candles into provisional buckets', () => {
    const candle = (
      time_ms: number,
      high: string,
      low: string,
      close: string,
    ) => ({
      time_ms,
      open: '100',
      high,
      low,
      close,
      volume_btc: '1.5',
      closed: true,
    })
    expect(
      aggregateCandles(
        [
          candle(BASE, '105', '99', '101'),
          candle(BASE + M, '108', '97', '103'),
          candle(BASE + 5 * M, '104', '98', '102'),
        ],
        5 * M,
      ),
    ).toEqual([
      {
        time_ms: BASE,
        open: '100',
        high: '108',
        low: '97',
        close: '103',
        volume_btc: '3',
        closed: false,
      },
      {
        time_ms: BASE + 5 * M,
        open: '100',
        high: '104',
        low: '98',
        close: '102',
        volume_btc: '1.5',
        closed: false,
      },
    ])
  })

  it('serves official candles, fills the unpublished tail from finer ones, and folds analytics', async () => {
    const path = dbPath()
    const writer = new FuturesMarketStore(path)
    closers.push(() => writer.close())
    // Official 1h up to 02:00; 15m for 03:00-03:15; 1m for 03:30.
    saveOfficial(writer, H, [BASE, BASE + H, BASE + 2 * H])
    saveOfficial(writer, 15 * M, [BASE + 3 * H, BASE + 3 * H + 15 * M], '105')
    saveOfficial(writer, M, [BASE + 3 * H + 30 * M], '107')
    saveAnalytics(writer, 'cvd', [BASE + 3 * H, BASE + 3 * H + 15 * M], {
      buy_volume: ['1.5', '2'],
      sell_volume: ['0.5', '1'],
      cvd: ['1', '2'],
    })
    saveAnalytics(
      writer,
      'open-interest',
      [BASE + H, BASE + 2 * H],
      [
        ['10', '12', '9', '11'],
        ['11', '13', '10', '12'],
      ],
      H,
    )
    saveAnalytics(
      writer,
      'cvd',
      [BASE + H, BASE + 2 * H],
      { buy_volume: ['3', '4'], sell_volume: ['1', '2'], cvd: ['0', '0'] },
      H,
    )
    saveAnalytics(writer, 'orderbook', [BASE + 3 * H], {
      bid: { bestPrice: ['84262'], liquidity01: ['535.9'] },
      ask: { bestPrice: ['84263'], liquidity01: ['483.3'] },
    })
    writer.append({
      type: 'ticker',
      productId: 'PF_XBTUSD',
      seq: 1,
      epoch: 1,
      eventTime: BASE + 3 * H + 31 * M,
      receivedAt: BASE + 3 * H + 31 * M + 5,
      persistedAt: BASE + 3 * H + 31 * M + 5,
      last: '84228',
      mark: '84224.7',
      suspended: false,
      funding: { status: 'unknown' },
      rawJson: JSON.stringify(rawTicker),
    })
    const app = await buildLiveGateway({
      marketDbPath: path,
      pollMs: 20,
      clock: () => BASE + 3 * H + 31 * M + 10,
    })
    closers.push(() => app.close())

    const hourly = (
      await app.inject('/api/terminal/chart?interval_ms=3600000')
    ).json() as any
    expect(hourly.schema_version).toBe('futures-terminal-chart.v1')
    expect(
      hourly.candles.map((candle: any) => [
        (candle.time_ms - BASE) / H,
        candle.close,
        candle.closed,
      ]),
    ).toEqual([
      [0, '100', true],
      [1, '100', true],
      [2, '100', true],
      // 03:00 is not published as 1h yet: built from 15m + 1m.
      [3, '107', false],
    ])
    expect(hourly.candles.at(-1).volume_btc).toBe('6')
    expect(
      hourly.flow.map((flow: any) => [
        (flow.time_ms - BASE) / H,
        flow.buy_volume,
        flow.sell_volume,
        flow.open_interest,
      ]),
    ).toEqual([
      [1, 3, 1, 11],
      [2, 4, 2, 12],
    ])
    expect(hourly.depth).toEqual({
      time_ms: BASE + 3 * H,
      bid: { bestPrice: 84262, liquidity01: 535.9 },
      ask: { bestPrice: 84263, liquidity01: 483.3 },
    })
    expect(hourly.ticker.open_interest).toBe(2222.6546)

    // 15m and below fold the minute analytics.
    const quarter = (
      await app.inject('/api/terminal/chart?interval_ms=900000')
    ).json() as any
    expect(
      quarter.flow.map((flow: any) => [
        (flow.time_ms - BASE) / M,
        flow.buy_volume,
      ]),
    ).toEqual([
      [180, 1.5],
      [195, 2],
    ])

    const bootstrap = (
      await app.inject('/api/terminal/bootstrap')
    ).json() as any
    expect(bootstrap.market.ticker_stats.funding_rate_prediction).toBe(
      0.6279870261864448,
    )
    expect(
      (await app.inject('/api/terminal/chart?interval_ms=1800000')).statusCode,
    ).toBe(400)
  })

  it('answers with an empty chart before capture exists', async () => {
    const app = await buildLiveGateway({ marketDbPath: dbPath(), pollMs: 20 })
    closers.push(() => app.close())
    const body = (
      await app.inject('/api/terminal/chart?interval_ms=300000')
    ).json() as any
    expect(body).toMatchObject({ interval_ms: 300000, candles: [], flow: [] })
  })
})
