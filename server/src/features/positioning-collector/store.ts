import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { SeriesKind } from './catalog.ts'

export const POSITIONING_STORE_VERSION = 'positioning.v1'
export const HOUR_MS = 3_600_000
export const MINUTE_MS = 60_000

/** One hour of Kraken's account split: all accounts and the top 20 % by size. */
export type PositioningRow = Readonly<{
  productId: string
  bucketMs: number
  longPercent: number | null
  longCount: number | null
  shortCount: number | null
  topLongPercent: number | null
  topLongCount: number | null
  topShortCount: number | null
  topOpenInterest: number | null
}>

/** Perpetual (mark) against spot index at the close of one candle. */
export type PremiumRow = Readonly<{
  productId: string
  intervalMs: number
  bucketMs: number
  mark: number
  spot: number
  /** (mark - spot) / spot in basis points. */
  premiumBp: number
}>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS positioning(
  product_id TEXT NOT NULL, bucket_ms INTEGER NOT NULL,
  long_percent REAL, long_count INTEGER, short_count INTEGER,
  top_long_percent REAL, top_long_count INTEGER, top_short_count INTEGER, top_open_interest REAL,
  PRIMARY KEY(product_id, bucket_ms)) WITHOUT ROWID, STRICT;
CREATE TABLE IF NOT EXISTS premium(
  product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_ms INTEGER NOT NULL,
  mark REAL NOT NULL, spot REAL NOT NULL, premium_bp REAL NOT NULL,
  PRIMARY KEY(product_id, interval_ms, bucket_ms)) WITHOUT ROWID, STRICT;
CREATE TABLE IF NOT EXISTS collector_run(
  run_id INTEGER PRIMARY KEY AUTOINCREMENT, started_ms INTEGER NOT NULL, stopped_ms INTEGER,
  stop_reason TEXT, version TEXT NOT NULL) STRICT;
`

type Raw = Record<string, number | string | null>
const num = (value: unknown): number | null =>
  typeof value === 'number' ? value : null

/**
 * Own database of the positioning collector (sole writer: the collector, under
 * its writer lock). Readers (gateway, Python) open it read-only.
 */
export class PositioningStore {
  readonly db: DatabaseSync
  private runId = 0

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (options.readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true })
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
    this.db.exec(SCHEMA)
  }

  startRun(now: number): void {
    this.db
      .prepare(
        "UPDATE collector_run SET stopped_ms=?, stop_reason='no clean stop' WHERE stopped_ms IS NULL",
      )
      .run(now)
    this.runId = Number(
      this.db
        .prepare('INSERT INTO collector_run(started_ms, version) VALUES(?,?)')
        .run(now, POSITIONING_STORE_VERSION).lastInsertRowid,
    )
  }

  stopRun(now: number, reason: string): void {
    if (this.runId)
      this.db
        .prepare(
          'UPDATE collector_run SET stopped_ms=?, stop_reason=? WHERE run_id=?',
        )
        .run(now, reason, this.runId)
  }

  /** All-accounts side of an hour; the top-20 % side is filled by `putTop`. */
  putAll(
    productId: string,
    bucketMs: number,
    row: { percent: number; longCount: number; shortCount: number },
  ): void {
    this.ensure(productId, bucketMs)
    this.db
      .prepare(
        'UPDATE positioning SET long_percent=?, long_count=?, short_count=? WHERE product_id=? AND bucket_ms=?',
      )
      .run(row.percent, row.longCount, row.shortCount, productId, bucketMs)
  }

  putTop(
    productId: string,
    bucketMs: number,
    row: {
      percent: number
      longCount: number
      shortCount: number
      openInterest: number
    },
  ): void {
    this.ensure(productId, bucketMs)
    this.db
      .prepare(
        'UPDATE positioning SET top_long_percent=?, top_long_count=?, top_short_count=?, top_open_interest=? WHERE product_id=? AND bucket_ms=?',
      )
      .run(
        row.percent,
        row.longCount,
        row.shortCount,
        row.openInterest,
        productId,
        bucketMs,
      )
  }

  private ensure(productId: string, bucketMs: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO positioning(product_id, bucket_ms) VALUES(?,?)',
      )
      .run(productId, bucketMs)
  }

  putPremium(rows: readonly PremiumRow[]): number {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO premium VALUES(?,?,?,?,?,?)',
    )
    let written = 0
    this.db.exec('BEGIN')
    try {
      for (const row of rows) {
        insert.run(
          row.productId,
          row.intervalMs,
          row.bucketMs,
          row.mark,
          row.spot,
          row.premiumBp,
        )
        written += 1
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return written
  }

  /** Newest stored bucket of a series (`positioning` side or `premium` interval). */
  latestPositioning(
    productId: string,
    side: 'all' | 'top',
  ): number | undefined {
    const column = side === 'all' ? 'long_percent' : 'top_long_percent'
    const row = this.db
      .prepare(
        `SELECT MAX(bucket_ms) AS t FROM positioning WHERE product_id=? AND ${column} IS NOT NULL`,
      )
      .get(productId) as { t: number | null }
    return row.t ?? undefined
  }

  latestPremium(productId: string, intervalMs: number): number | undefined {
    const row = this.db
      .prepare(
        'SELECT MAX(bucket_ms) AS t FROM premium WHERE product_id=? AND interval_ms=?',
      )
      .get(productId, intervalMs) as { t: number | null }
    return row.t ?? undefined
  }

  /** Drops one series of one product older than `fromMs` (the minute window rolls forward). */
  trimBefore(productId: string, kind: SeriesKind, fromMs: number): number {
    if (kind !== 'minute') return 0
    return Number(
      this.db
        .prepare(
          'DELETE FROM premium WHERE product_id=? AND interval_ms=? AND bucket_ms<?',
        )
        .run(productId, MINUTE_MS, fromMs).changes,
    )
  }

  /** Deletes every stored row of one series of one product (an archived indicator past its delay). */
  deleteSeries(productId: string, kind: SeriesKind): number {
    if (kind === 'hour' || kind === 'minute')
      return Number(
        this.db
          .prepare('DELETE FROM premium WHERE product_id=? AND interval_ms=?')
          .run(productId, kind === 'hour' ? HOUR_MS : MINUTE_MS).changes,
      )
    const columns =
      kind === 'all'
        ? 'long_percent=NULL, long_count=NULL, short_count=NULL'
        : 'top_long_percent=NULL, top_long_count=NULL, top_short_count=NULL, top_open_interest=NULL'
    const cleared = Number(
      this.db
        .prepare(`UPDATE positioning SET ${columns} WHERE product_id=?`)
        .run(productId).changes,
    )
    this.db
      .prepare(
        'DELETE FROM positioning WHERE product_id=? AND long_percent IS NULL AND top_long_percent IS NULL',
      )
      .run(productId)
    return cleared
  }

  positioningSince(
    productId: string,
    fromMs: number,
    toMs: number = Number.MAX_SAFE_INTEGER,
  ): PositioningRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM positioning WHERE product_id=? AND bucket_ms>=? AND bucket_ms<=? ORDER BY bucket_ms`,
        )
        .all(productId, fromMs, toMs) as Raw[]
    ).map((row) => ({
      productId,
      bucketMs: Number(row.bucket_ms),
      longPercent: num(row.long_percent),
      longCount: num(row.long_count),
      shortCount: num(row.short_count),
      topLongPercent: num(row.top_long_percent),
      topLongCount: num(row.top_long_count),
      topShortCount: num(row.top_short_count),
      topOpenInterest: num(row.top_open_interest),
    }))
  }

  premiumSince(
    productId: string,
    intervalMs: number,
    fromMs: number,
    toMs: number = Number.MAX_SAFE_INTEGER,
  ): PremiumRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM premium WHERE product_id=? AND interval_ms=? AND bucket_ms>=? AND bucket_ms<=? ORDER BY bucket_ms`,
        )
        .all(productId, intervalMs, fromMs, toMs) as Raw[]
    ).map((row) => ({
      productId,
      intervalMs,
      bucketMs: Number(row.bucket_ms),
      mark: Number(row.mark),
      spot: Number(row.spot),
      premiumBp: Number(row.premium_bp),
    }))
  }

  close(): void {
    this.db.close()
  }
}
