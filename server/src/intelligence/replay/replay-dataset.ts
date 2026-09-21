import type { TimestampMs } from '../contracts.ts'
import { contentHashFor } from '../forecast-hashing.ts'
import { INTERVAL_MS, type CandleInterval } from '../market/intraday-candles.ts'
import {
  ReplayDatasetFreezeError,
  type BackfillConflictEvidence,
  type BackfillGapEvidence,
  type FrozenReplayDataset,
  type ReplayDatasetCandle,
  type ReplayTrade,
} from './replay-contracts.ts'

export interface FreezeReplayDatasetInput {
  readonly interval: CandleInterval
  readonly importVersion: string
  readonly trades: readonly ReplayTrade[]
  readonly gaps: readonly BackfillGapEvidence[]
  readonly conflicts: readonly BackfillConflictEvidence[]
  readonly asOfTimestamp?: TimestampMs
}

/**
 * Freeze a candle-native dataset. Only closed candles are kept (the
 * still-forming last candle is dropped, matching the browser provider rule),
 * and a dataset with unresolved gaps or conflicting duplicates is rejected.
 */
export function freezeReplayDataset(
  input: FreezeReplayDatasetInput,
): FrozenReplayDataset {
  if (input.importVersion.trim().length === 0)
    throw new ReplayDatasetFreezeError(
      'invalid_import_version',
      'A frozen dataset requires a non-empty import version.',
    )
  if (input.conflicts.length > 0)
    throw new ReplayDatasetFreezeError(
      'conflicting_duplicate',
      'A dataset with conflicting duplicate trades cannot be frozen.',
    )
  if (input.gaps.some((gap) => !gap.resolved))
    throw new ReplayDatasetFreezeError(
      'unresolved_gap',
      'A dataset with unresolved gaps cannot be frozen.',
    )
  const asOfTimestamp = input.asOfTimestamp ?? maxEventTime(input.trades)
  const candles = buildClosedCandles(
    input.trades,
    input.interval,
    asOfTimestamp,
  )
  if (candles.length === 0)
    throw new ReplayDatasetFreezeError(
      'empty_dataset',
      'A dataset must contain at least one closed candle.',
    )
  const withoutHash: Omit<FrozenReplayDataset, 'datasetHash'> = {
    instrumentId: 'BTC-EUR',
    source: 'kraken',
    importVersion: input.importVersion,
    interval: input.interval,
    asOfTimestamp,
    candles,
    gapEvidence: input.gaps,
    conflictEvidence: input.conflicts,
  }
  return { ...withoutHash, datasetHash: replayDatasetHash(withoutHash) }
}

/**
 * Aggregate trades into closed OHLCV candles. Trades after the explicit
 * `asOfTimestamp` are excluded (no look-ahead) and any candle whose bucket has
 * not fully closed at the cutoff is dropped.
 */
export function buildClosedCandles(
  trades: readonly ReplayTrade[],
  interval: CandleInterval,
  asOfTimestamp: TimestampMs,
): readonly ReplayDatasetCandle[] {
  const intervalMs = INTERVAL_MS[interval]
  if (intervalMs === undefined)
    throw new ReplayDatasetFreezeError(
      'invalid_interval',
      `Unsupported replay interval: ${String(interval)}.`,
    )
  const sorted = [...trades].sort(compareTrades)
  const buckets = new Map<number, ReplayTrade[]>()
  for (const trade of sorted) {
    if (trade.eventTime > asOfTimestamp) continue
    const bucketStart = Math.floor(trade.eventTime / intervalMs) * intervalMs
    const bucket = buckets.get(bucketStart)
    if (bucket === undefined) buckets.set(bucketStart, [trade])
    else bucket.push(trade)
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucketStart, bucket]) =>
      aggregateCandle(interval, bucketStart, intervalMs, asOfTimestamp, bucket),
    )
    .filter((candle) => candle.isClosed)
}

/**
 * Canonical dataset hash. The projection deliberately excludes local receive
 * and detection timestamps so the same fixture input and import version hash
 * identically regardless of wall-clock time.
 */
export function replayDatasetHash(
  dataset: Omit<FrozenReplayDataset, 'datasetHash'>,
): string {
  return contentHashFor({
    instrumentId: dataset.instrumentId,
    source: dataset.source,
    importVersion: dataset.importVersion,
    interval: dataset.interval,
    asOfTimestamp: dataset.asOfTimestamp,
    candles: dataset.candles,
    gaps: dataset.gapEvidence.map(projectGap),
    conflicts: dataset.conflictEvidence.map(projectConflict),
  })
}

function aggregateCandle(
  interval: CandleInterval,
  bucketStart: number,
  intervalMs: number,
  asOfTimestamp: TimestampMs,
  trades: readonly ReplayTrade[],
): ReplayDatasetCandle {
  const first = trades[0] as ReplayTrade
  const last = trades[trades.length - 1] as ReplayTrade
  const prices = trades.map((trade) => trade.price)
  const bucketEnd = bucketStart + intervalMs
  return {
    interval,
    bucketStart: bucketStart as TimestampMs,
    bucketEnd: bucketEnd as TimestampMs,
    open: first.price,
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: last.price,
    volume: trades.reduce((total, trade) => total + trade.qty, 0),
    tradeCount: trades.length,
    firstTradeId: first.tradeId,
    lastTradeId: last.tradeId,
    eventTimeStart: first.eventTime,
    eventTimeEnd: last.eventTime,
    isClosed: bucketEnd <= asOfTimestamp,
  }
}

function compareTrades(left: ReplayTrade, right: ReplayTrade): number {
  if (left.eventTime !== right.eventTime)
    return left.eventTime - right.eventTime
  return left.tradeId - right.tradeId
}

function maxEventTime(trades: readonly ReplayTrade[]): TimestampMs {
  let highest = 0
  for (const trade of trades)
    if (trade.eventTime > highest) highest = trade.eventTime
  return highest as TimestampMs
}

function projectGap(gap: BackfillGapEvidence): Record<string, unknown> {
  return {
    kind: gap.kind,
    window: gap.window,
    previousTradeId: gap.previousTradeId,
    nextTradeId: gap.nextTradeId,
    missingTradeIds: gap.missingTradeIds,
    resolved: gap.resolved,
    resolution: gap.resolution,
  }
}

function projectConflict(
  conflict: BackfillConflictEvidence,
): Record<string, unknown> {
  return {
    tradeId: conflict.tradeId,
    window: conflict.window,
    existing: projectTrade(conflict.existing),
    incoming: projectTrade(conflict.incoming),
  }
}

function projectTrade(trade: ReplayTrade): Record<string, unknown> {
  return {
    tradeId: trade.tradeId,
    eventTime: trade.eventTime,
    price: trade.price,
    qty: trade.qty,
    side: trade.side,
    orderType: trade.orderType ?? null,
  }
}
