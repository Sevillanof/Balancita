import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { captureSavingsFromEnv, retentionFromEnv } from './capture-savings.ts'
import { FuturesMarketStore } from './futures-market-store.ts'
import {
  fundingSlimBody,
  isFundingSlimBody,
  parseHistoricalFundingResponse,
} from './historical-funding.ts'
import { parseAnalytics } from './market-analytics.ts'
import { pruneMarketEvents } from './futures-market-prune.ts'
import { createRetentionRunner } from './retention-runner.ts'

const H = 3_600_000
const DAY = 24 * H
const dirs: string[] = []
const dbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-savings-'))
  dirs.push(dir)
  return join(dir, 'market.sqlite')
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const rows = <T>(path: string, sql: string): T[] => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

describe('retention defaults and switches', () => {
  it('keeps tickers and the raw copy 48 h, trades 7 days', () => {
    expect(retentionFromEnv({})).toEqual({
      tickerRetentionMs: 48 * H,
      eventRetentionMs: 7 * DAY,
      rawKeepMs: 48 * H,
    })
  })

  it('still lets the environment override them', () => {
    expect(
      retentionFromEnv({
        FUTURES_TICKER_RETENTION_HOURS: '12',
        FUTURES_EVENT_RETENTION_DAYS: '3',
        FUTURES_RAW_COPY_KEEP_HOURS: '6',
        // Not a positive number: falls back to the default.
      }),
    ).toEqual({
      tickerRetentionMs: 12 * H,
      eventRetentionMs: 3 * DAY,
      rawKeepMs: 6 * H,
    })
    expect(
      retentionFromEnv({ FUTURES_TICKER_RETENTION_HOURS: 'abc' })
        .tickerRetentionMs,
    ).toBe(48 * H)
  })

  it('has every saving switch off by default and on only for an explicit yes', () => {
    expect(captureSavingsFromEnv({})).toEqual({
      fundingBodyDaily: false,
      analyticsRawSlim: false,
    })
    expect(
      captureSavingsFromEnv({
        FUTURES_FUNDING_BODY_DAILY: '0',
        FUTURES_ANALYTICS_RAW_SLIM: '',
        FUTURES_CANDLE_REVISIONS_COMPACT: 'no',
      }),
    ).toEqual({ fundingBodyDaily: false, analyticsRawSlim: false })
    expect(
      captureSavingsFromEnv({
        FUTURES_FUNDING_BODY_DAILY: '1',
        FUTURES_ANALYTICS_RAW_SLIM: 'true',
        FUTURES_CANDLE_REVISIONS_COMPACT: 'on',
      }),
    ).toEqual({
      fundingBodyDaily: true,
      analyticsRawSlim: true,
      candleCompaction: { settleMs: 6 * H },
    })
    expect(
      captureSavingsFromEnv({
        FUTURES_CANDLE_REVISIONS_COMPACT: '1',
        FUTURES_CANDLE_REVISIONS_SETTLE_HOURS: '2',
      }).candleCompaction,
    ).toEqual({ settleMs: 2 * H })
  })
})

describe('48 h retention on the store', () => {
  const ticker = (seq: number, at: number) => ({
    type: 'ticker',
    productId: 'PF_XBTUSD',
    seq,
    eventTime: at - 5,
    receivedAt: at,
    persistedAt: at + 5,
    epoch: 1,
    bid: '1',
    ask: '2',
    mark: '1.5',
    raw: { bid_size: '1' },
  })
  const trade = (uid: string, at: number, seq: number) => ({
    type: 'trade',
    productId: 'PF_XBTUSD',
    seq,
    eventTime: at - 5,
    receivedAt: at,
    persistedAt: at + 5,
    epoch: 1,
    uid,
    side: 'buy',
    tradeType: 'fill',
    quantityBtc: '0.01',
    priceUsd: '90000',
    recovered: false,
    raw: { price: '90000' },
  })

  it('keeps a 30 h old ticker and its trade copy whole, drops/compacts them past 48 h', () => {
    const NOW = 100 * DAY
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    store.append(ticker(1, NOW - 50 * H))
    store.append(trade('t50', NOW - 50 * H + 1, 2))
    store.append(ticker(3, NOW - 30 * H))
    store.append(trade('t30', NOW - 30 * H + 1, 4))
    const result = store.trimRawEvents({ now: NOW, ...retentionFromEnv({}) })
    expect(result).toMatchObject({ deleted: 1, slimmed: 1, done: true })
    store.close()
    const left = rows<{ uid: string | null; feed: string; has: string | null }>(
      path,
      "SELECT uid, feed, json_type(normalized_json,'$.raw') AS has FROM paper_futures_market_events ORDER BY rowid",
    )
    expect(left.map((r) => r.uid ?? r.feed)).toEqual(['t50', 'ticker', 't30'])
    expect(left.find((r) => r.uid === 't50')?.has).toBeNull() // past 48 h: raw copy dropped
    expect(left.find((r) => r.uid === 't30')?.has).not.toBeNull() // 30 h: still whole
  })
})

describe('legacy ticker_snapshots table', () => {
  it('is not created in a new database', () => {
    const path = dbPath()
    new FuturesMarketStore(path).close()
    expect(
      rows(
        path,
        "SELECT name FROM sqlite_master WHERE name LIKE '%ticker_snapshots%'",
      ),
    ).toEqual([])
  })

  it('is left alone in an old database, which opens, appends and prunes as before', () => {
    const path = dbPath()
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE paper_futures_ticker_snapshots (
      event_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
      event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, payload_json TEXT NOT NULL) STRICT`)
    old.close()
    const store = new FuturesMarketStore(path)
    store.append(ticker(1, 1_000))
    store.close()
    expect(() =>
      pruneMarketEvents(path, { days: 1, now: 10 * DAY }),
    ).not.toThrow()
    expect(
      rows(path, 'SELECT COUNT(*) AS n FROM paper_futures_ticker_snapshots'),
    ).toEqual([{ n: 0 }])
  })
})

describe('funding responses: FUTURES_FUNDING_BODY_DAILY', () => {
  const D = 200 * DAY
  const period = (hour: number, rate: string) =>
    `{"timestamp":"${new Date(D + hour * H).toISOString().replace('.000Z', 'Z')}","fundingRate":${rate},"relativeFundingRate":${Number(rate) / 100}}`
  // A response lists all the history it knows: hours 0..lastHour.
  const body = (lastHour: number, serverAt: number) =>
    `{"result":"success","serverTime":"${new Date(serverAt).toISOString()}","rates":[${Array.from({ length: lastHour + 1 }, (_, h) => period(h, `0.0000${h + 1}`)).join(',')}]}`
  const response = (lastHour: number, receivedAt: number) =>
    parseHistoricalFundingResponse(body(lastHour, receivedAt), receivedAt)
  const fill = (store: FuturesMarketStore) => {
    store.appendNewFundingKnowledge(response(8, D + 9 * H + 1_000)) // first of the day
    store.appendNewFundingKnowledge(response(9, D + 10 * H + 1_000)) // one new period
    store.appendNewFundingKnowledge(response(10, D + 11 * H + 1_000)) // one new period
    store.appendNewFundingKnowledge(response(23, D + DAY + H + 1_000)) // next day
  }
  const stored = (path: string) =>
    rows<{ sha256: string; raw_response: string; received_at: number }>(
      path,
      'SELECT sha256, raw_response, received_at FROM paper_futures_funding_responses ORDER BY received_at',
    )
  const periods = (path: string) =>
    rows(
      path,
      'SELECT response_sha256, start_ms, end_ms, funding_rate, known_at, unit, product_id FROM paper_futures_funding_periods ORDER BY start_ms, known_at',
    )

  it('off: every response keeps its whole body (the former behavior)', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    fill(store)
    store.close()
    const all = stored(path)
    expect(all).toHaveLength(4)
    for (const row of all)
      expect(isFundingSlimBody(row.raw_response)).toBe(false)
    expect(all[1]!.raw_response).toBe(body(9, D + 10 * H + 1_000))
  })

  it('on: one full body per UTC day, the others keep only their new periods; periods and hashes are identical', () => {
    const offPath = dbPath()
    const off = new FuturesMarketStore(offPath)
    fill(off)
    off.close()
    const path = dbPath()
    const store = new FuturesMarketStore(path, {
      savings: { fundingBodyDaily: true },
    })
    fill(store)
    store.close()
    const all = stored(path)
    expect(all.map((r) => isFundingSlimBody(r.raw_response))).toEqual([
      false,
      true,
      true,
      false,
    ])
    // Same response rows (hash = primary key of the full body) and the very same periods.
    expect(all.map((r) => r.sha256)).toEqual(
      stored(offPath).map((r) => r.sha256),
    )
    expect(periods(path)).toEqual(periods(offPath))
    // The slim body is valid JSON with the rates of its new period only, in Kraken's own text.
    const slim = JSON.parse(all[1]!.raw_response) as {
      fullSha256: string
      fullBytes: number
      rates: Array<{ timestamp: string; relativeFundingRate: number }>
    }
    expect(slim.fullSha256).toBe(all[1]!.sha256)
    expect(slim.fullBytes).toBe(
      Buffer.byteLength(body(9, D + 10 * H + 1_000), 'utf8'),
    )
    expect(slim.rates).toHaveLength(1)
    expect(slim.rates[0]!.timestamp).toBe(
      new Date(D + 9 * H).toISOString().replace('.000Z', 'Z'),
    )
    expect(all[1]!.raw_response).toContain(period(9, '0.000010'))
    expect(all[3]!.raw_response.length).toBeGreaterThan(
      all[1]!.raw_response.length,
    )
  })

  it('on: a restart in the same day does not store a second full body', () => {
    const path = dbPath()
    const first = new FuturesMarketStore(path, {
      savings: { fundingBodyDaily: true },
    })
    first.appendNewFundingKnowledge(response(8, D + 9 * H + 1_000))
    first.close()
    const second = new FuturesMarketStore(path, {
      savings: { fundingBodyDaily: true },
    })
    second.appendNewFundingKnowledge(response(9, D + 10 * H + 1_000))
    second.close()
    expect(stored(path).map((r) => isFundingSlimBody(r.raw_response))).toEqual([
      false,
      true,
    ])
  })

  it('on: re-recording a slim response in full (appendFundingResponse) is not a hash conflict', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path, {
      savings: { fundingBodyDaily: true },
    })
    store.appendNewFundingKnowledge(response(8, D + 9 * H + 1_000))
    const second = response(9, D + 10 * H + 1_000)
    store.appendNewFundingKnowledge(second)
    expect(() => store.appendFundingResponse(second)).not.toThrow()
    store.close()
  })

  it('a slim body refuses to drop a period it must keep', () => {
    const full = response(9, D + 10 * H + 1_000)
    expect(() => fundingSlimBody(full, new Set([D + 99 * H]))).toThrow(
      /lacks a period/,
    )
  })
})

describe('analytics responses: FUTURES_ANALYTICS_RAW_SLIM', () => {
  const T = 1_700_000_000_000 - (1_700_000_000_000 % 60_000)
  const raw = JSON.stringify({
    result: {
      timestamp: [T / 1000, T / 1000 + 60, T / 1000 + 120],
      data: { buy_volume: ['1', '2', '3'], sell_volume: ['1', '1', '1'] },
      more: false,
    },
    errors: [],
  })
  const parse = () =>
    parseAnalytics(raw, {
      productId: 'PF_XBTUSD',
      metric: 'cvd',
      intervalMs: 60_000,
      fromMs: T,
      receivedAtMs: T + 5 * 60_000,
    })

  it('off keeps the body; on keeps hash and size but the points are identical', () => {
    const offPath = dbPath()
    const off = new FuturesMarketStore(offPath)
    off.appendAnalytics(parse())
    const onPath = dbPath()
    const on = new FuturesMarketStore(onPath, {
      savings: { analyticsRawSlim: true },
    })
    on.appendAnalytics(parse())
    const read = (s: FuturesMarketStore) =>
      s.analyticsSince('PF_XBTUSD', 'cvd', 60_000, T, 100)
    expect(read(on)).toEqual(read(off))
    expect(read(on)).toHaveLength(3)
    expect(on.latestAnalyticsBucket('PF_XBTUSD', 'cvd', 60_000)).toBe(
      off.latestAnalyticsBucket('PF_XBTUSD', 'cvd', 60_000),
    )
    // A re-fetch still writes nothing, in both modes.
    expect(on.appendAnalytics(parse())).toEqual({ inserted: 0 })
    off.close()
    on.close()
    const sql =
      'SELECT sha256, raw_response FROM paper_futures_analytics_responses'
    const [offRow] = rows<{ sha256: string; raw_response: string }>(
      offPath,
      sql,
    )
    const [onRow] = rows<{ sha256: string; raw_response: string }>(onPath, sql)
    expect(offRow!.raw_response).toBe(raw)
    expect(JSON.parse(onRow!.raw_response)).toEqual({
      balancitaSlim: true,
      sha256: onRow!.sha256,
      bytes: Buffer.byteLength(raw, 'utf8'),
    })
    expect(onRow!.sha256).toBe(offRow!.sha256)
    const points =
      'SELECT * FROM paper_futures_analytics_points ORDER BY bucket_start'
    expect(rows(onPath, points)).toEqual(rows(offPath, points))
  })
})

describe('candle revisions: FUTURES_CANDLE_REVISIONS_COMPACT', () => {
  const M = 60_000
  const T0 = 1_000 * DAY
  const save = (
    store: FuturesMarketStore,
    bucket: number,
    revision: number,
    isClosed: boolean,
    product = 'PF_XBTUSD',
  ) =>
    store.saveCandleRevision({
      id: `${product}:${M}:${bucket}`,
      intervalMs: M,
      bucketStart: bucket,
      revision,
      knownAt: bucket + revision * 100,
      ...(isClosed ? { closeAt: bucket + M } : {}),
      isClosed,
      coverage: 'observed_trades_only_no_gap_certification',
      open: '100',
      high: String(100 + revision),
      low: '99',
      close: String(100 + revision),
      volumeBtc: String(revision),
      tradeCount: revision,
      sourceHash: String(revision).padStart(64, 'a'),
    })
  const revisionsOf = (path: string, bucket: number) =>
    rows<{ revision: number }>(
      path,
      `SELECT revision FROM paper_futures_candle_revisions WHERE bucket_start=${bucket} ORDER BY revision`,
    ).map((r) => r.revision)

  function seeded() {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    // A: four open revisions then the closing one. B: three open, closed, and a late closed revision.
    for (let r = 1; r <= 4; r += 1) save(store, T0, r, false)
    save(store, T0, 5, true)
    for (let r = 1; r <= 3; r += 1) save(store, T0 + M, r, false)
    save(store, T0 + M, 4, true)
    save(store, T0 + M, 5, true)
    // C: still open and recent (not settled).
    for (let r = 1; r <= 4; r += 1) save(store, T0 + 600 * M, r, false)
    return { path, store }
  }
  const compactAll = (store: FuturesMarketStore, now: number) => {
    let deleted = 0
    for (let i = 0; i < 1_000; i += 1) {
      const step = store.compactCandleRevisions({ now, settleMs: 6 * H })
      deleted += step.deleted
      if (step.done) return deleted
    }
    throw new Error('compaction did not finish')
  }

  it('deletes only intermediate open revisions of settled candles', () => {
    const { path, store } = seeded()
    const before = {
      tail: store.closedCandlesTail(M),
      head: store.candleHeadById(`PF_XBTUSD:${M}:${T0}`),
      asOf: store.candlesAsOf(T0 + 10 * H),
    }
    const now = T0 + 600 * M + 2 * M // C is two minutes old
    expect(compactAll(store, now)).toBe(3 + 2) // A: 2,3,4 ; B: 2,3
    expect(compactAll(store, now)).toBe(0) // nothing left to do
    expect(store.closedCandlesTail(M)).toEqual(before.tail)
    expect(store.candleHeadById(`PF_XBTUSD:${M}:${T0}`)).toEqual(before.head)
    expect(store.candlesAsOf(T0 + 10 * H)).toEqual(before.asOf)
    store.close()
    expect(revisionsOf(path, T0)).toEqual([1, 5])
    expect(revisionsOf(path, T0 + M)).toEqual([1, 4, 5])
    expect(revisionsOf(path, T0 + 600 * M)).toEqual([1, 2, 3, 4]) // not settled
  })

  it('puts the delete guard back and keeps working on a store with nothing to compact', () => {
    const { path, store } = seeded()
    compactAll(store, T0 + 600 * M + 2 * M)
    store.close()
    const db = new DatabaseSync(path)
    expect(() => db.exec('DELETE FROM paper_futures_candle_revisions')).toThrow(
      /immutable/,
    )
    db.close()
    const empty = new FuturesMarketStore(dbPath())
    expect(empty.compactCandleRevisions({ now: T0, settleMs: H })).toEqual({
      deleted: 0,
      done: true,
    })
    empty.close()
  })

  it('the runner compacts only when given the hook, and reports it', async () => {
    const trimmed = { deleted: 0, slimmed: 0, done: true, batches: 1 }
    const store = { trimRawEvents: () => trimmed }
    const policy = retentionFromEnv({})
    const without = await createRetentionRunner({
      store,
      policy,
      yieldLoop: () => Promise.resolve(),
    }).run()
    expect(without?.done).toBe(true)
    expect(without).not.toHaveProperty('candleRevisionsCompacted')
    let calls = 0
    const withHook = await createRetentionRunner({
      store,
      policy,
      yieldLoop: () => Promise.resolve(),
      candles: {
        step: () => {
          calls += 1
          return { deleted: 10, done: calls >= 3 }
        },
      },
    }).run()
    expect(calls).toBe(3)
    expect(withHook).toMatchObject({ done: true, candleRevisionsCompacted: 30 })
  })
})

const ticker = (seq: number, at: number) => ({
  type: 'ticker',
  productId: 'PF_XBTUSD',
  seq,
  eventTime: at - 5,
  receivedAt: at,
  persistedAt: at + 5,
  epoch: 1,
  bid: '1',
  ask: '2',
  mark: '1.5',
  raw: { bid_size: '1' },
})
