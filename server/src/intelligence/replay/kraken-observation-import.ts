import { DatabaseSync } from 'node:sqlite'
import type { TimestampMs } from '../contracts.ts'
import type { StoredMarketObservation } from '../market/market-store.ts'
import { freezeReplayDataset } from './replay-dataset.ts'
import type {
  BackfillConflictEvidence,
  BackfillGapEvidence,
  BackfillWindow,
  FrozenReplayDataset,
  ReplayTrade,
} from './replay-contracts.ts'

/**
 * Import version for datasets built from already-collected Kraken
 * `market_observations`. It is part of the deterministic run id, so bumping it
 * starts a fresh replay lineage instead of colliding with previous runs.
 */
export const KRAKEN_OBSERVATIONS_IMPORT_VERSION = 'kraken-observations.v1'

export type LiveDatabaseOpener = (
  path: string,
  options: { readOnly: boolean },
) => DatabaseSync

function defaultOpener(
  path: string,
  options: { readOnly: boolean },
): DatabaseSync {
  return new DatabaseSync(path, options)
}

/**
 * Open the live market database strictly read-only. The opener is injectable
 * so tests can assert the read-only flag without touching the real file.
 */
export function openLiveMarketDbReadOnly(
  path: string,
  open: LiveDatabaseOpener = defaultOpener,
): DatabaseSync {
  return open(path, { readOnly: true })
}

export interface KrakenObservationWindow {
  readonly since?: TimestampMs
  readonly until?: TimestampMs
}

type SqlRow = Record<string, unknown>

/**
 * Read Kraken BTC-EUR observations with a single SELECT snapshot. The caller
 * owns the handle (opened read-only); this function never writes, migrates, or
 * deletes. A single ordered snapshot tolerates the live collector appending
 * concurrently: each run simply replays whatever was committed when it read.
 */
export function readKrakenObservationRows(
  database: Pick<DatabaseSync, 'prepare'>,
  window: KrakenObservationWindow,
): StoredMarketObservation[] {
  const clauses = [`source = 'kraken'`, `instrument_id = 'BTC-EUR'`]
  const parameters: number[] = []
  if (window.since !== undefined) {
    clauses.push('event_time >= ?')
    parameters.push(window.since)
  }
  if (window.until !== undefined) {
    clauses.push('event_time <= ?')
    parameters.push(window.until)
  }
  const rows = database
    .prepare(
      `SELECT id, source, instrument_id, event_time, received_time, display_time,
              sequence, status, payload_json, freshness_age_ms, freshness_is_stale,
              content_hash, created_at
         FROM market_observations
        WHERE ${clauses.join(' AND ')}
        ORDER BY event_time, rowid`,
    )
    .all(...parameters) as SqlRow[]
  return rows.map((row) => ({
    id: String(row.id),
    source: String(row.source),
    instrumentId: 'BTC-EUR',
    eventTime: Number(row.event_time) as TimestampMs,
    receivedTime: Number(row.received_time) as TimestampMs,
    displayTime: Number(row.display_time) as TimestampMs,
    ...(row.sequence === null ? {} : { sequence: Number(row.sequence) }),
    status: row.status as StoredMarketObservation['status'],
    payload: JSON.parse(
      String(row.payload_json),
    ) as StoredMarketObservation['payload'],
    freshnessAgeMs: Number(row.freshness_age_ms),
    freshnessIsStale: Number(row.freshness_is_stale) === 1,
    contentHash: String(row.content_hash),
    createdAt: Number(row.created_at) as TimestampMs,
  }))
}

/**
 * Map one stored observation to a replay trade. Non-trade payloads (ticker,
 * heartbeat) carry no fill quantity or side, and non-Kraken rows are out of
 * scope for this pipeline, so both map to null (counted as skipped).
 */
export function mapObservationToReplayTrade(
  observation: StoredMarketObservation,
): ReplayTrade | null {
  if (observation.source !== 'kraken') return null
  const payload = observation.payload
  if (payload.type !== 'trade') return null
  return {
    instrumentId: 'BTC-EUR',
    source: 'kraken',
    tradeId: payload.tradeId,
    eventTime: observation.eventTime,
    receivedTime: observation.receivedTime,
    price: payload.price,
    qty: payload.qty,
    side: payload.side,
    ...(payload.orderType === undefined
      ? {}
      : { orderType: payload.orderType }),
    origin: 'archive',
  }
}

export interface ImportedReplayTrades {
  readonly trades: readonly ReplayTrade[]
  readonly gaps: readonly BackfillGapEvidence[]
  readonly conflicts: readonly BackfillConflictEvidence[]
  readonly skipped: number
  readonly duplicateCount: number
}

/**
 * Map observations to trades, dedupe identical repeats, and surface gaps and
 * conflicts as evidence. Kraken trade ids in this collector stream are
 * contiguous per instrument (verified against live data: backfilled ranges
 * show zero discontinuities), so any trade-id discontinuity inside the window
 * means lost data and is reported as an unresolved gap. Freezing then fails
 * closed; use a --since/--until window to scope a clean contiguous range.
 */
export function importReplayTradesFromObservations(
  observations: readonly StoredMarketObservation[],
  window: KrakenObservationWindow = {},
): ImportedReplayTrades {
  let skipped = 0
  let duplicateCount = 0
  const byTradeId = new Map<number, ReplayTrade>()
  const conflicts: BackfillConflictEvidence[] = []
  for (const observation of observations) {
    if (
      (window.since !== undefined && observation.eventTime < window.since) ||
      (window.until !== undefined && observation.eventTime > window.until)
    ) {
      skipped += 1
      continue
    }
    const trade = mapObservationToReplayTrade(observation)
    if (trade === null) {
      skipped += 1
      continue
    }
    const existing = byTradeId.get(trade.tradeId)
    if (existing === undefined) {
      byTradeId.set(trade.tradeId, trade)
    } else if (sameTradeContent(existing, trade)) {
      duplicateCount += 1
    } else {
      conflicts.push({
        tradeId: trade.tradeId,
        window: evidenceWindow([...byTradeId.values(), trade]),
        existing,
        incoming: trade,
        detectedAt: trade.eventTime,
      })
    }
  }
  const trades = [...byTradeId.values()].sort(compareTrades)
  return {
    trades,
    gaps: detectTradeIdGaps(trades),
    conflicts,
    skipped,
    duplicateCount,
  }
}

export interface FreezeFromObservationsOptions extends KrakenObservationWindow {
  readonly asOfTimestamp?: TimestampMs
}

/**
 * Map, dedupe, and freeze observations into 1m candles. Fails closed on
 * unresolved gaps, conflicting duplicates, or empty input via
 * freezeReplayDataset; never silently skips missing data.
 */
export function freezeDatasetFromObservations(
  observations: readonly StoredMarketObservation[],
  options: FreezeFromObservationsOptions = {},
): FrozenReplayDataset {
  const imported = importReplayTradesFromObservations(observations, options)
  return freezeReplayDataset({
    interval: '1m',
    importVersion: KRAKEN_OBSERVATIONS_IMPORT_VERSION,
    trades: imported.trades,
    gaps: imported.gaps,
    conflicts: imported.conflicts,
    ...(options.asOfTimestamp === undefined
      ? {}
      : { asOfTimestamp: options.asOfTimestamp }),
  })
}

function sameTradeContent(left: ReplayTrade, right: ReplayTrade): boolean {
  return (
    left.eventTime === right.eventTime &&
    left.price === right.price &&
    left.qty === right.qty &&
    left.side === right.side &&
    (left.orderType ?? null) === (right.orderType ?? null)
  )
}

function compareTrades(left: ReplayTrade, right: ReplayTrade): number {
  if (left.eventTime !== right.eventTime)
    return left.eventTime - right.eventTime
  return left.tradeId - right.tradeId
}

function detectTradeIdGaps(
  trades: readonly ReplayTrade[],
): BackfillGapEvidence[] {
  const gaps: BackfillGapEvidence[] = []
  if (trades.length === 0) return gaps
  const window = evidenceWindow(trades)
  const detectedAt = trades[trades.length - 1]!.eventTime
  for (let index = 1; index < trades.length; index += 1) {
    const previous = trades[index - 1]!
    const next = trades[index]!
    if (next.tradeId <= previous.tradeId) continue
    if (next.tradeId === previous.tradeId + 1) continue
    const missingTradeIds: number[] = []
    for (
      let tradeId = previous.tradeId + 1;
      tradeId < next.tradeId;
      tradeId += 1
    ) {
      missingTradeIds.push(tradeId)
    }
    gaps.push({
      kind: 'trade_id',
      window,
      previousTradeId: previous.tradeId,
      nextTradeId: next.tradeId,
      missingTradeIds,
      detectedAt,
      resolved: false,
      resolution: 'unresolved',
    })
  }
  return gaps
}

function evidenceWindow(trades: readonly ReplayTrade[]): BackfillWindow {
  let startTime = trades[0]!.eventTime
  let endTime = trades[0]!.eventTime
  for (const trade of trades) {
    if (trade.eventTime < startTime) startTime = trade.eventTime
    if (trade.eventTime > endTime) endTime = trade.eventTime
  }
  return { index: 0, startTime, endTime }
}
