import { DatabaseSync } from 'node:sqlite'
import { acquireWriterLock } from '../../platform/writer-lock.ts'

export const DEFAULT_RETENTION_DAYS = 7

const DAY_MS = 86_400_000
const GUARDED = [
  'paper_futures_market_events',
  'paper_futures_book_snapshots',
  'paper_futures_ticker_snapshots',
] as const

export interface PruneResult {
  readonly cutoffMs: number
  readonly events: number
  readonly bookSnapshots: number
  readonly tickerSnapshots: number
}

/**
 * Offline retention (SS-10): deletes raw market events (trades, tickers, books)
 * received before `now - days`. Official candles, candle revisions, funding,
 * analytics and gaps are never touched. The tables are immutable evidence while
 * capture runs, so this takes the capture's writer lock (it refuses to run while
 * capture is up) and lifts each table's delete guard only inside one
 * transaction, restoring it before commit. Rowids of the kept events do not
 * change, so readers that tail by rowid keep working.
 */
export function pruneMarketEvents(
  dbPath: string,
  {
    days = DEFAULT_RETENTION_DAYS,
    now = Date.now(),
  }: { days?: number; now?: number } = {},
): PruneResult {
  if (!Number.isFinite(days) || days < 1)
    throw new RangeError('Retention must be at least 1 day.')
  const cutoffMs = now - days * DAY_MS
  const lock = acquireWriterLock(dbPath)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('BEGIN IMMEDIATE')
    const guards = GUARDED.map((table) => {
      const row = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`,
        )
        .get(`${table}_no_delete`) as { sql: string } | undefined
      return { table, sql: row?.sql }
    })
    for (const { table, sql } of guards)
      if (sql) db.exec(`DROP TRIGGER ${table}_no_delete`)
    const old = `SELECT event_id FROM paper_futures_market_events WHERE received_at < ${Math.trunc(cutoffMs)}`
    const bookSnapshots = Number(
      db
        .prepare(
          `DELETE FROM paper_futures_book_snapshots WHERE event_id IN (${old})`,
        )
        .run().changes,
    )
    const tickerSnapshots = Number(
      db
        .prepare(
          `DELETE FROM paper_futures_ticker_snapshots WHERE event_id IN (${old})`,
        )
        .run().changes,
    )
    const events = Number(
      db
        .prepare(
          `DELETE FROM paper_futures_market_events WHERE received_at < ?`,
        )
        .run(Math.trunc(cutoffMs)).changes,
    )
    for (const { sql } of guards) if (sql) db.exec(sql)
    db.exec('COMMIT')
    return { cutoffMs, events, bookSnapshots, tickerSnapshots }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // No open transaction.
    }
    throw error
  } finally {
    db.close()
    lock.release()
  }
}
