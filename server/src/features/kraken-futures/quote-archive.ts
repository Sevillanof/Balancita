import { mkdirSync, statfsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acquireWriterLock } from '../../platform/writer-lock.ts'

/**
 * Temporary bid/ask archive. The capture keeps tickers 24 h; this process
 * copies a thinned bid/ask series into its OWN database before they expire,
 * reading the market database read-only. It never writes to the capture's
 * database or changes its retention. Public data only.
 *
 * These are top-of-book quotes (best bid/ask and their sizes), not order-book
 * snapshots: they say nothing about depth.
 */
export const QUOTE_ARCHIVE_VERSION = 'quote-archive.v1'
const DAY_MS = 86_400_000
const BATCH = 5_000

export interface QuoteArchiveOptions {
  readonly marketDb: string
  readonly quotesDb: string
  /** At most one quote per product in this many ms (the capture polls every second). */
  readonly minIntervalMs?: number
  /** Oldest quote kept. */
  readonly maxDays?: number
  /** Hard cap for the archive file; the oldest rows go first. */
  readonly maxBytes?: number
  /** A silence longer than this between two quotes of a product is logged as a gap. */
  readonly gapMs?: number
  /** Stop (and log it) when the volume has less free space than this. */
  readonly minFreeBytes?: number
  readonly now?: number
}

export interface QuoteArchiveResult {
  readonly read: number
  readonly stored: number
  readonly gaps: number
  readonly trimmed: number
  readonly stopped: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quote_snapshot(
  product_id TEXT NOT NULL, received_at INTEGER NOT NULL, bid TEXT NOT NULL, ask TEXT NOT NULL,
  bid_size TEXT, ask_size TEXT, mark TEXT, last TEXT, source TEXT NOT NULL,
  PRIMARY KEY(product_id, received_at)) STRICT;
CREATE TABLE IF NOT EXISTS quote_archive_state(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS quote_archive_gap(
  gap_id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL,
  reason TEXT NOT NULL, logged_ms INTEGER NOT NULL) STRICT;
`

type Row = {
  rid: number
  product_id: string
  received_at: number
  normalized_json: string
}

function sizeOf(raw: unknown, rawJson: unknown, key: string): string | null {
  const direct = (raw as Record<string, unknown> | undefined)?.[key]
  if (typeof direct === 'string') return direct
  if (typeof rawJson !== 'string') return null
  try {
    const value = (JSON.parse(rawJson) as Record<string, unknown>)[key]
    return value === undefined || value === null ? null : String(value)
  } catch {
    return null
  }
}

export function archiveQuotes(
  options: QuoteArchiveOptions,
): QuoteArchiveResult {
  const now = options.now ?? Date.now()
  const minIntervalMs = options.minIntervalMs ?? 10_000
  const maxDays = options.maxDays ?? 30
  const maxBytes = options.maxBytes ?? 300 * 1_048_576
  const gapMs = options.gapMs ?? 120_000
  const minFree = options.minFreeBytes ?? 5 * 1_073_741_824
  mkdirSync(dirname(options.quotesDb), { recursive: true })
  const lock = acquireWriterLock(options.quotesDb)
  const out = new DatabaseSync(options.quotesDb)
  const src = new DatabaseSync(options.marketDb, { readOnly: true })
  try {
    out.exec(SCHEMA)
    const state = (key: string) =>
      (
        out
          .prepare('SELECT value FROM quote_archive_state WHERE key=?')
          .get(key) as { value: string } | undefined
      )?.value
    const setState = (key: string, value: string) =>
      out
        .prepare('INSERT OR REPLACE INTO quote_archive_state VALUES(?,?)')
        .run(key, value)
    const logGap = (
      product: string | null,
      from: number,
      to: number,
      reason: string,
    ) =>
      out
        .prepare(
          'INSERT INTO quote_archive_gap(product_id,from_ms,to_ms,reason,logged_ms) VALUES(?,?,?,?,?)',
        )
        .run(product, from, to, reason, now)
    let gaps = 0
    let read = 0
    let stored = 0
    let stopped: string | null = null

    let cursor = Number(state('cursor') ?? 0)
    const last = new Map<string, number>(
      (
        out
          .prepare(
            'SELECT product_id, MAX(received_at) AS t FROM quote_snapshot GROUP BY product_id',
          )
          .all() as { product_id: string; t: number }[]
      ).map((r) => [r.product_id, r.t]),
    )

    // The capture's rowids restart if its table was emptied: a cursor ahead of the data means a new sequence.
    const maxRid = Number(
      (
        src
          .prepare(
            "SELECT COALESCE(MAX(rowid),0) AS m FROM paper_futures_market_events WHERE feed='ticker'",
          )
          .get() as { m: number }
      ).m,
    )
    if (cursor > maxRid) {
      logGap(
        null,
        Number(state('last_received_at') ?? 0),
        now,
        'capture sequence restarted: cursor was ahead of the data',
      )
      gaps += 1
      cursor = 0
    }
    // Tickers expired before this process read them (it was down longer than the capture's retention).
    const oldest = src
      .prepare(
        "SELECT MIN(received_at) AS t FROM paper_futures_market_events WHERE feed='ticker' AND rowid>?",
      )
      .get(cursor) as { t: number | null }
    const lastSeen = Number(state('last_received_at') ?? 0)
    if (lastSeen > 0 && oldest.t !== null && oldest.t - lastSeen > gapMs) {
      logGap(
        null,
        lastSeen,
        oldest.t,
        'archiver down: tickers in between expired before being read',
      )
      gaps += 1
    }

    const select = src.prepare(
      'SELECT rowid AS rid, product_id, received_at, normalized_json FROM paper_futures_market_events ' +
        "WHERE feed='ticker' AND rowid>? ORDER BY rowid LIMIT ?",
    )
    const insert = out.prepare(
      'INSERT OR IGNORE INTO quote_snapshot VALUES(?,?,?,?,?,?,?,?,?)',
    )
    for (;;) {
      const free = statfsSync(dirname(options.quotesDb))
      if (Number(free.bavail) * Number(free.bsize) < minFree) {
        stopped = 'low disk space'
        logGap(null, lastSeen, now, 'stopped: free disk space under the limit')
        gaps += 1
        break
      }
      const rows = select.all(cursor, BATCH) as Row[]
      if (rows.length === 0) break
      out.exec('BEGIN')
      for (const row of rows) {
        read += 1
        cursor = row.rid
        const previous = last.get(row.product_id)
        if (
          previous !== undefined &&
          row.received_at - previous < minIntervalMs
        )
          continue
        let event: Record<string, unknown>
        try {
          event = JSON.parse(row.normalized_json) as Record<string, unknown>
        } catch {
          continue
        }
        const bid = event.bid
        const ask = event.ask
        if (typeof bid !== 'string' || typeof ask !== 'string') continue
        if (previous !== undefined && row.received_at - previous > gapMs) {
          logGap(
            row.product_id,
            previous,
            row.received_at,
            'no quotes for this product',
          )
          gaps += 1
        }
        stored += insert.run(
          row.product_id,
          row.received_at,
          bid,
          ask,
          sizeOf(event.raw, event.rawJson, 'bid_size'),
          sizeOf(event.raw, event.rawJson, 'ask_size'),
          typeof event.mark === 'string' ? event.mark : null,
          typeof event.last === 'string' ? event.last : null,
          (event.raw as Record<string, unknown> | undefined)?.source === 'rest'
            ? 'rest'
            : 'ws',
        ).changes as number
        last.set(row.product_id, row.received_at)
        setState(
          'last_received_at',
          String(
            Math.max(Number(state('last_received_at') ?? 0), row.received_at),
          ),
        )
      }
      setState('cursor', String(cursor))
      out.exec('COMMIT')
    }
    setState('cursor', String(cursor))
    setState('version', QUOTE_ARCHIVE_VERSION)

    // Storage limits: age first, then the size cap (oldest rows go).
    let trimmed = Number(
      out
        .prepare('DELETE FROM quote_snapshot WHERE received_at < ?')
        .run(now - maxDays * DAY_MS).changes,
    )
    for (
      let guard = 0;
      guard < 50 && statSync(options.quotesDb).size > maxBytes;
      guard += 1
    ) {
      const total = Number(
        (
          out.prepare('SELECT COUNT(*) AS n FROM quote_snapshot').get() as {
            n: number
          }
        ).n,
      )
      if (total === 0) break
      trimmed += Number(
        out
          .prepare(
            'DELETE FROM quote_snapshot WHERE rowid IN (SELECT rowid FROM quote_snapshot ORDER BY received_at LIMIT ?)',
          )
          .run(Math.max(1, Math.ceil(total / 10))).changes,
      )
      out.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM')
    }
    return { read, stored, gaps, trimmed, stopped }
  } finally {
    src.close()
    out.close()
    lock.release()
  }
}
