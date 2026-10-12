import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DepthRow } from './book.ts'

export const BOOK_STORE_VERSION = 'book-depth.v1'
const DAY_MS = 86_400_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS book_depth(
  product_id TEXT NOT NULL, received_at INTEGER NOT NULL, seq INTEGER NOT NULL,
  best_bid REAL NOT NULL, best_ask REAL NOT NULL, spread_bp REAL NOT NULL,
  bid_depth_json TEXT NOT NULL, ask_depth_json TEXT NOT NULL,
  top_bids_json TEXT NOT NULL, top_asks_json TEXT NOT NULL,
  bid_levels INTEGER NOT NULL, ask_levels INTEGER NOT NULL,
  PRIMARY KEY(product_id, received_at)) STRICT;
CREATE TABLE IF NOT EXISTS book_gap(
  gap_id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL,
  reason TEXT NOT NULL, logged_ms INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS collector_run(
  run_id INTEGER PRIMARY KEY AUTOINCREMENT, started_ms INTEGER NOT NULL, stopped_ms INTEGER,
  stop_reason TEXT, version TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS collector_stat(
  at_ms INTEGER PRIMARY KEY, messages INTEGER NOT NULL, per_second REAL NOT NULL, rss_mb REAL NOT NULL,
  db_mb REAL NOT NULL, apply_ms_p99 REAL NOT NULL) STRICT;
`

export class BookStore {
  readonly db: DatabaseSync
  readonly path: string
  private runId = 0

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA auto_vacuum=INCREMENTAL;',
    )
    this.db.exec(SCHEMA)
  }

  /** Opens a run; a previous run that never closed means the process died: its silence is logged as a gap. */
  startRun(now: number): { previousStopped: number | null } {
    const lastSeen = this.db
      .prepare('SELECT MAX(received_at) AS t FROM book_depth')
      .get() as { t: number | null }
    const open = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM collector_run WHERE stopped_ms IS NULL',
      )
      .get() as { n: number }
    if (open.n > 0) {
      this.db
        .prepare(
          "UPDATE collector_run SET stopped_ms=?, stop_reason='crashed or killed (no clean stop)' WHERE stopped_ms IS NULL",
        )
        .run(lastSeen.t ?? now)
    }
    if (lastSeen.t !== null && now - lastSeen.t > 0)
      this.gap(
        null,
        lastSeen.t,
        now,
        open.n > 0 ? 'collector down (no clean stop)' : 'collector down',
      )
    this.runId = Number(
      this.db
        .prepare('INSERT INTO collector_run(started_ms, version) VALUES(?,?)')
        .run(now, BOOK_STORE_VERSION).lastInsertRowid,
    )
    return { previousStopped: lastSeen.t }
  }

  stopRun(now: number, reason: string) {
    if (this.runId)
      this.db
        .prepare(
          'UPDATE collector_run SET stopped_ms=?, stop_reason=? WHERE run_id=?',
        )
        .run(now, reason, this.runId)
  }

  gap(product: string | null, from: number, to: number, reason: string) {
    this.db
      .prepare(
        'INSERT INTO book_gap(product_id,from_ms,to_ms,reason,logged_ms) VALUES(?,?,?,?,?)',
      )
      .run(product, from, to, reason, Date.now())
  }

  depth(row: DepthRow): number {
    return Number(
      this.db
        .prepare(
          'INSERT OR IGNORE INTO book_depth VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          row.productId,
          row.receivedAt,
          row.seq,
          row.bestBid,
          row.bestAsk,
          row.spreadBp,
          JSON.stringify(row.bidDepth),
          JSON.stringify(row.askDepth),
          JSON.stringify(row.topBids),
          JSON.stringify(row.topAsks),
          row.levels.bids,
          row.levels.asks,
        ).changes,
    )
  }

  stat(
    at: number,
    messages: number,
    perSecond: number,
    rssMb: number,
    p99: number,
  ) {
    this.db
      .prepare('INSERT OR REPLACE INTO collector_stat VALUES(?,?,?,?,?,?)')
      .run(
        at,
        messages,
        perSecond,
        rssMb,
        statSync(this.path).size / 1_048_576,
        p99,
      )
  }

  /** Age first, then size: oldest rows go until the file fits. Returns rows removed. */
  enforceLimits(now: number, maxDays: number, maxBytes: number): number {
    let removed = Number(
      this.db
        .prepare('DELETE FROM book_depth WHERE received_at < ?')
        .run(now - maxDays * DAY_MS).changes,
    )
    this.db
      .prepare('DELETE FROM collector_stat WHERE at_ms < ?')
      .run(now - maxDays * DAY_MS)
    for (
      let guard = 0;
      guard < 50 && statSync(this.path).size > maxBytes;
      guard += 1
    ) {
      const n = Number(
        (
          this.db.prepare('SELECT COUNT(*) AS n FROM book_depth').get() as {
            n: number
          }
        ).n,
      )
      if (n === 0) break
      removed += Number(
        this.db
          .prepare(
            'DELETE FROM book_depth WHERE rowid IN (SELECT rowid FROM book_depth ORDER BY received_at LIMIT ?)',
          )
          .run(Math.max(1, Math.ceil(n / 10))).changes,
      )
      this.db.exec(
        'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;',
      )
    }
    return removed
  }

  close() {
    this.db.close()
  }
}
