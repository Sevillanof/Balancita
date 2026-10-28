import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'

/**
 * Representative SQLite and JSON sources for the health report, shared by the
 * tests and the benchmark. The market DB gets its real schema from
 * `FuturesMarketStore`; the Python-owned DBs copy the DDL of their writers
 * (futures_verdicts.py, futures_forward.py, futures_strategy_registry.py,
 * futures_llm_decisions.py). Everything lives under a temp folder.
 */
export const PRODUCTS = [
  'PF_XBTUSD',
  'PF_ETHUSD',
  'PF_SOLUSD',
  'PF_XRPUSD',
  'PF_ADAUSD',
  'PF_DOGEUSD',
  'PF_LINKUSD',
  'PF_LTCUSD',
] as const

export const MINUTE = 60_000

export interface Sandbox {
  readonly dir: string
  readonly marketDb: string
  readonly verdictsDb: string
  readonly decisionsDb: string
  readonly forwardDb: string
  readonly strategiesDb: string
  readonly healthFile: string
  readonly resilienceLog: string
  readonly qwenExitSummary: string
  readonly kronosSummary: string
  readonly registration: string
  readonly specsDir: string
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-health-'))
  mkdirSync(join(dir, 'forward'))
  mkdirSync(join(dir, 'specs'))
  return {
    dir,
    marketDb: join(dir, 'futures-market.sqlite'),
    verdictsDb: join(dir, 'futures-verdicts.sqlite'),
    decisionsDb: join(dir, 'futures-llm-decisions.sqlite'),
    forwardDb: join(dir, 'forward', 'forward.sqlite'),
    strategiesDb: join(dir, 'futures-strategies.sqlite'),
    healthFile: join(dir, 'dev-health.json'),
    resilienceLog: join(dir, 'resilience.jsonl'),
    qwenExitSummary: join(dir, 'qwen-exit-summary.json'),
    kronosSummary: join(dir, 'kronos-summary.json'),
    registration: join(dir, 'forward-strategies.json'),
    specsDir: join(dir, 'specs'),
  }
}

function open(path: string): DatabaseSync {
  return new DatabaseSync(path)
}

export interface MarketSeed {
  readonly now: number
  /** Ticker age per product in ms; omitted products get none. */
  readonly tickerAgeMs?: Partial<Record<string, number>>
  /** Closed 1 min candle age (since its close) per product. */
  readonly candleAgeMs?: Partial<Record<string, number>>
  /** Prices of those candles (default the toy 1 / 2 / 0.5 / 1.5). */
  readonly candlePrices?: {
    readonly open: string
    readonly high: string
    readonly low: string
    readonly close: string
  }
  /** An extra recent event of this feed (a trade, for «WS up, ticker stale»). */
  readonly otherFeed?: { feed: string; product: string; ageMs: number }
  readonly gaps?: readonly { product: string; ageMs: number; feed?: string }[]
  /** Extra ticker rows per product spread over the retention (for the benchmark). */
  readonly historyTickersPerProduct?: number
  readonly historyCandlesPerProduct?: number
  /** Size of each event's raw JSON in bytes (real tickers are ~1 KB). */
  readonly payloadBytes?: number
  /** Trades kept (7 days of retention) for PF_XBTUSD, spread backwards. */
  readonly historyTradesXbt?: number
}

export function seedMarket(path: string, seed: MarketSeed): void {
  new FuturesMarketStore(path).close()
  const db = open(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF')
  const event = db.prepare(
    `INSERT INTO paper_futures_market_events
     (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,raw_json,normalized_json,content_hash)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const response = db.prepare(
    `INSERT OR IGNORE INTO paper_futures_official_candle_responses
     (product_id,sha256,interval_ms,from_ms,to_ms,received_at,raw_response) VALUES(?,?,?,?,?,?,?)`,
  )
  const candle = db.prepare(
    `INSERT INTO paper_futures_official_candles
     (product_id,interval_ms,bucket_start,revision_hash,known_at,open_price,high_price,low_price,close_price,volume_btc,response_sha256)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const payload = JSON.stringify({
    feed: 'ticker',
    last: 100.5,
    pad: 'x'.repeat(Math.max(0, (seed.payloadBytes ?? 60) - 40)),
  })
  let n = 0
  const addEvent = (
    feed: string,
    product: string,
    at: number,
    uid?: string,
  ) => {
    n += 1
    event.run(
      `e${n}`,
      feed,
      product,
      1_000_000,
      n,
      at,
      at,
      at,
      uid ?? null,
      payload,
      '{"last":"100.5","mark":"100.4"}',
      `h${n}`,
    )
  }
  db.exec('BEGIN')
  for (const product of PRODUCTS) {
    const age = seed.tickerAgeMs?.[product]
    if (age !== undefined) addEvent('ticker', product, seed.now - age)
    const history = seed.historyTickersPerProduct ?? 0
    for (let i = 1; i <= history; i += 1)
      addEvent('ticker', product, seed.now - 11 * MINUTE - i * 1000)
    const closeAge = seed.candleAgeMs?.[product]
    const candles = Math.max(
      closeAge === undefined ? 0 : 1,
      seed.historyCandlesPerProduct ?? 0,
    )
    for (let i = 0; i < candles; i += 1) {
      const close = seed.now - (closeAge ?? 0) - i * MINUTE
      const bucket = close - MINUTE
      const sha = `${product}-${bucket}`
      response.run(product, sha, MINUTE, bucket, close, close + 3000, '{}')
      candle.run(
        product,
        MINUTE,
        bucket,
        `r${bucket}`,
        close + 3000,
        seed.candlePrices?.open ?? '1',
        seed.candlePrices?.high ?? '2',
        seed.candlePrices?.low ?? '0.5',
        seed.candlePrices?.close ?? '1.5',
        '3',
        sha,
      )
    }
  }
  for (let i = 1; i <= (seed.historyTradesXbt ?? 0); i += 1)
    addEvent('trade', 'PF_XBTUSD', seed.now - 11 * MINUTE - i * 2000, `t${i}`)
  if (seed.otherFeed)
    addEvent(
      seed.otherFeed.feed,
      seed.otherFeed.product,
      seed.now - seed.otherFeed.ageMs,
      `u${n}`,
    )
  const gap = db.prepare(
    `INSERT INTO paper_futures_data_gaps
     (gap_id,feed,product_id,epoch,expected_seq,actual_seq,detected_at,reason,policy_version) VALUES(?,?,?,?,?,?,?,?,?)`,
  )
  for (const [i, g] of (seed.gaps ?? []).entries())
    gap.run(
      `g${i}`,
      g.feed ?? 'official_candles',
      g.product,
      1,
      null,
      1,
      seed.now - g.ageMs,
      'hole',
      'v1',
    )
  db.exec('COMMIT')
  db.close()
}

export interface VerdictSeed {
  readonly now: number
  /** Age of the newest verdict per product (ms since written); omitted: none. */
  readonly newestAgeMs?: Partial<Record<string, number>>
  /** Rows to write backwards from the newest, one per minute. */
  readonly perProduct?: number
  readonly action?: string
}

export function seedVerdicts(path: string, seed: VerdictSeed): void {
  const db = open(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF')
  db.exec(`CREATE TABLE IF NOT EXISTS paper_futures_verdicts(
    product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
    decision_known_at INTEGER NOT NULL, regime TEXT NOT NULL,
    action TEXT NOT NULL, reason_code TEXT NOT NULL,
    verdict_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
    written_at INTEGER NOT NULL,
    PRIMARY KEY(product_id, bucket_start)) STRICT`)
  const insert = db.prepare(
    'INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)',
  )
  db.exec('BEGIN')
  for (const product of PRODUCTS) {
    const age = seed.newestAgeMs?.[product]
    if (age === undefined) continue
    for (let i = 0; i < (seed.perProduct ?? 10); i += 1) {
      const written = seed.now - age - i * MINUTE
      const bucket = written - (written % MINUTE) - MINUTE
      insert.run(
        product,
        bucket,
        MINUTE,
        written - 5000,
        'range',
        seed.action ?? 'WAIT',
        'no_setup',
        `v${product}${bucket}`,
        '{}',
        written,
      )
    }
  }
  db.exec('COMMIT')
  db.close()
}

export interface ForwardSeed {
  readonly now: number
  readonly strategies: readonly string[]
  readonly checkedAgeMs: number
  readonly candleLagMs?: number
  readonly diverged?: number
  readonly legacyDiverged?: number
  readonly trades?: number
  /**
   * Per `strategy/product`: the cycle age in ms, or null for no row at all.
   * Pairs not listed use `checkedAgeMs`.
   */
  readonly pairs?: Readonly<Record<string, number | null>>
  readonly products?: readonly string[]
}

export function seedForward(path: string, seed: ForwardSeed): void {
  const db = open(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS forward_trade(strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
      spec_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(strategy_id, product_id, entry_bucket_ms, spec_hash)) STRICT;
    CREATE TABLE IF NOT EXISTS forward_open(strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      payload TEXT, PRIMARY KEY(strategy_id, product_id)) STRICT;
    CREATE TABLE IF NOT EXISTS forward_status(strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(strategy_id, product_id)) STRICT;`)
  const status = db.prepare('INSERT INTO forward_status VALUES(?,?,?)')
  const open_ = db.prepare('INSERT INTO forward_open VALUES(?,?,?,?)')
  const trade = db.prepare('INSERT INTO forward_trade VALUES(?,?,?,?,?)')
  db.exec('BEGIN')
  for (const strategy of seed.strategies)
    for (const [i, product] of (seed.products ?? PRODUCTS).entries()) {
      const age =
        seed.pairs && `${strategy}/${product}` in seed.pairs
          ? seed.pairs[`${strategy}/${product}`]!
          : seed.checkedAgeMs
      if (age === null) continue
      status.run(
        strategy,
        product,
        JSON.stringify({
          checked_ms: seed.now - age,
          missing_1m: 0,
          late_1m: 0,
          diverged_trades: i === 0 ? (seed.diverged ?? 0) : 0,
          legacy_diverged_trades: i === 0 ? (seed.legacyDiverged ?? 0) : 0,
          blocked_stale_entries: 0,
          stale_cycles: 0,
          candle_lag_ms: seed.candleLagMs ?? 90_000,
        }),
      )
      open_.run(strategy, product, 'h', i === 0 ? null : 'null')
      for (let t = 0; t < (seed.trades ?? 0); t += 1)
        trade.run(strategy, product, seed.now - (t + 1) * 3_600_000, 'h', '{}')
    }
  db.exec('COMMIT')
  db.close()
}

export function seedStrategies(
  path: string,
  strategies: readonly { id: string; state: string }[],
  now: number,
): void {
  const db = open(path)
  db.exec(`CREATE TABLE IF NOT EXISTS strategy_events(
    seq INTEGER PRIMARY KEY, strategy_id TEXT NOT NULL, version INTEGER NOT NULL,
    state TEXT NOT NULL, reason TEXT NOT NULL, known_at INTEGER NOT NULL) STRICT`)
  const insert = db.prepare(
    'INSERT INTO strategy_events(strategy_id,version,state,reason,known_at) VALUES(?,?,?,?,?)',
  )
  for (const s of strategies) {
    insert.run(s.id, 1, 'draft', 'created', now - 4 * 3_600_000)
    insert.run(s.id, 1, s.state, 'set', now - 2 * 3_600_000)
  }
  db.close()
}

export function seedDecisions(
  path: string,
  writtenAges: readonly number[],
  now: number,
): void {
  const db = open(path)
  db.exec(`CREATE TABLE IF NOT EXISTS paper_futures_llm_decisions(
    product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, question_id TEXT NOT NULL, written_at INTEGER NOT NULL) STRICT`)
  const insert = db.prepare(
    'INSERT INTO paper_futures_llm_decisions VALUES(?,?,?,?)',
  )
  for (const [i, age] of writtenAges.entries())
    insert.run('PF_XBTUSD', now - age - i, 'q', now - age)
  db.close()
}

export function writeHealthFile(
  path: string,
  now: number,
  processes: Record<string, 'running' | 'restarting' | 'down'>,
  ageMs = 2_000,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    path,
    JSON.stringify({
      updated_at_ms: now - ageMs,
      processes: Object.fromEntries(
        Object.entries(processes).map(([name, status]) => [
          name,
          { status, restarts: 0, since_ms: now - 3_600_000 },
        ]),
      ),
      ...extra,
    }),
  )
}

/** `forward-strategies.json` plus one spec file per id in `specs` (only the `id` matters here). */
export function writeForwardConfig(
  b: Sandbox,
  registered: readonly string[],
  specs: readonly string[],
): void {
  writeFileSync(
    b.registration,
    JSON.stringify({
      schema: 'futures-forward-strategies.v1',
      strategies: Object.fromEntries(
        registered.map((id) => [id, { start_ms: 1 }]),
      ),
    }),
  )
  for (const id of specs)
    writeFileSync(join(b.specsDir, `${id}.json`), JSON.stringify({ id }))
}

export interface VerdictRow {
  readonly product: string
  readonly bucket: number
  readonly action: string
  readonly reason: string
}

/** Verdict rows with a chosen action and reason (payload left empty: B2 never reads it). */
export function seedVerdictRows(
  path: string,
  rows: readonly VerdictRow[],
  /** Size of each stored payload in bytes (real verdicts carry several KB). */
  payloadBytes = 2,
): void {
  const db = open(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF')
  db.exec(`CREATE TABLE IF NOT EXISTS paper_futures_verdicts(
    product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
    decision_known_at INTEGER NOT NULL, regime TEXT NOT NULL,
    action TEXT NOT NULL, reason_code TEXT NOT NULL,
    verdict_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
    written_at INTEGER NOT NULL,
    PRIMARY KEY(product_id, bucket_start)) STRICT`)
  const insert = db.prepare(
    'INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)',
  )
  db.exec('BEGIN')
  for (const r of rows)
    insert.run(
      r.product,
      r.bucket,
      MINUTE,
      r.bucket + MINUTE + 3000,
      'range',
      r.action,
      r.reason,
      `v${r.product}${r.bucket}`,
      payloadBytes <= 2 ? '{}' : `"${'x'.repeat(payloadBytes - 2)}"`,
      r.bucket + MINUTE + 4000,
    )
  db.exec('COMMIT')
  db.close()
}

export interface TradeRow {
  readonly strategy: string
  readonly product: string
  readonly entry: number
  readonly side?: string
  readonly exit?: number
  readonly reason?: string
  /** Stored payload verbatim (to test one that does not parse). */
  readonly raw?: string
}

export function seedForwardTrades(
  path: string,
  trades: readonly TradeRow[],
): void {
  const db = open(path)
  db.exec(`CREATE TABLE IF NOT EXISTS forward_trade(strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
    spec_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(strategy_id, product_id, entry_bucket_ms, spec_hash)) STRICT`)
  const insert = db.prepare('INSERT INTO forward_trade VALUES(?,?,?,?,?)')
  db.exec('BEGIN')
  for (const t of trades)
    insert.run(
      t.strategy,
      t.product,
      t.entry,
      'h',
      t.raw ??
        JSON.stringify({
          side: t.side ?? 'LONG',
          entry_bucket_ms: t.entry,
          exit_bucket_ms: t.exit ?? t.entry + 3_600_000,
          exit_reason: t.reason ?? 'time',
        }),
    )
  db.exec('COMMIT')
  db.close()
}

export interface OfficialCandleSeed {
  readonly product: string
  readonly intervalMs: number
  readonly bucket: number
  /** Close price; the other fields are fixed so rows stay comparable. */
  readonly close?: string
  /** Optional shape of the first revision (default 100.0 / 101.25 / 99.75). */
  readonly open?: string
  readonly high?: string
  readonly low?: string
  /** An extra later revision of the same bucket (the first known one wins). */
  readonly revisionKnownAt?: number
  readonly revisionClose?: string
}
