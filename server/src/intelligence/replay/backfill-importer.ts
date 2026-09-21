import type { TimestampMs } from '../contracts.ts'
import {
  ReplayImportError,
  type BackfillConflictEvidence,
  type BackfillCursor,
  type BackfillGapEvidence,
  type BackfillImportResult,
  type BackfillSource,
  type BackfillSourcePage,
  type BackfillSourceRequest,
  type BackfillWindow,
  type GapResolution,
  type ReplayTrade,
} from './replay-contracts.ts'

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 100
const MAX_PAGES_PER_WINDOW = 10_000

export interface BackfillImportOptions {
  readonly windows: readonly BackfillWindow[]
  readonly archive: BackfillSource
  readonly rest?: BackfillSource
  readonly clock: () => TimestampMs
  readonly startingCursor?: BackfillCursor
  readonly maxAttempts?: number
  readonly backoffMs?: number
  readonly sleep?: (delayMs: number) => Promise<void>
}

/**
 * Split a range into half-open windows aligned to `windowMs` boundaries. The
 * first window always starts on an interval boundary so archive pages line up
 * deterministically.
 */
export function alignWindows(
  startTime: number,
  endTime: number,
  windowMs: number,
): readonly BackfillWindow[] {
  if (
    !Number.isSafeInteger(startTime) ||
    !Number.isSafeInteger(endTime) ||
    !Number.isSafeInteger(windowMs) ||
    windowMs <= 0 ||
    endTime <= startTime
  ) {
    throw new ReplayImportError(
      'invalid_windows',
      'Window alignment requires a positive interval and an increasing range.',
    )
  }
  const first = Math.floor(startTime / windowMs) * windowMs
  const windows: BackfillWindow[] = []
  let cursor = first
  let index = 0
  while (cursor < endTime) {
    windows.push({
      index,
      startTime: cursor as TimestampMs,
      endTime: (cursor + windowMs) as TimestampMs,
    })
    cursor += windowMs
    index += 1
  }
  return windows
}

/**
 * Cursor-based backfill importer. Archive windows are fetched in order and
 * merged by Kraken trade id. Detectable trade-id gaps are recorded as
 * evidence; a REST catch-up may resolve them, but the evidence is never
 * silently dropped. Conflicting duplicates (same trade id, different payload)
 * are recorded and excluded from the accepted trade set.
 */
export async function importBackfill(
  options: BackfillImportOptions,
): Promise<BackfillImportResult> {
  validateWindows(options.windows)
  const clock = options.clock
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  let cursor: BackfillCursor = options.startingCursor ?? {
    windowIndex: 0,
    lastTradeId: null,
    lastEventTime: null,
  }
  const tradesByTradeId = new Map<number, ReplayTrade>()
  const windowByTradeId = new Map<number, BackfillWindow>()
  const conflicts: BackfillConflictEvidence[] = []
  let duplicateCount = 0
  let attempts = 0

  const mergeTrade = (trade: ReplayTrade, window: BackfillWindow): void => {
    const existing = tradesByTradeId.get(trade.tradeId)
    if (existing === undefined) {
      tradesByTradeId.set(trade.tradeId, trade)
      windowByTradeId.set(trade.tradeId, window)
      return
    }
    if (sameTrade(existing, trade)) {
      duplicateCount += 1
      return
    }
    conflicts.push({
      tradeId: trade.tradeId,
      window,
      existing,
      incoming: trade,
      detectedAt: clock(),
    })
  }

  const fetchPage = async (
    source: BackfillSource,
    request: Omit<BackfillSourceRequest, 'attempt'>,
  ): Promise<BackfillSourcePage> => {
    let attempt = 0
    while (true) {
      attempt += 1
      attempts += 1
      try {
        return await source.fetchPage({ ...request, attempt })
      } catch (error) {
        if (attempt >= maxAttempts) throw error
        await sleep(backoffMs * 2 ** (attempt - 1))
      }
    }
  }

  for (const window of options.windows) {
    if (window.index < cursor.windowIndex) continue
    let page: BackfillSourcePage
    try {
      page = await fetchPage(options.archive, { window, cursor })
    } catch (error) {
      throw new ReplayImportError(
        'archive_fetch_failed',
        `Archive fetch failed for window ${window.index}.`,
        { cause: error },
      )
    }
    let pages = 0
    while (true) {
      for (const trade of page.trades) {
        if (
          trade.eventTime < window.startTime ||
          trade.eventTime >= window.endTime
        )
          continue
        mergeTrade(trade, window)
      }
      if (!page.hasMore) break
      pages += 1
      if (pages > MAX_PAGES_PER_WINDOW)
        throw new ReplayImportError(
          'archive_fetch_failed',
          'Backfill pagination did not terminate.',
        )
      const sinceTradeId = maxTradeId(page.trades)
      page = await fetchPage(options.archive, {
        window,
        cursor,
        ...(sinceTradeId === null ? {} : { sinceTradeId }),
      })
    }
    cursor = {
      windowIndex: window.index + 1,
      lastTradeId: maxTradeId(page.trades) ?? cursor.lastTradeId,
      lastEventTime: maxEventTime(page.trades) ?? cursor.lastEventTime,
    }
  }

  const gaps = await detectGaps({
    tradeIds: [...tradesByTradeId.keys()].sort((left, right) => left - right),
    tradesByTradeId,
    windowByTradeId,
    rest: options.rest,
    cursor,
    fetchPage,
    mergeTrade,
    clock,
  })

  const trades = [...tradesByTradeId.values()].sort(
    (left, right) => left.tradeId - right.tradeId,
  )
  const lastWindowIndex =
    options.windows.length === 0
      ? cursor.windowIndex
      : (options.windows[options.windows.length - 1] as BackfillWindow).index +
        1
  const finalCursor: BackfillCursor = {
    windowIndex: Math.max(cursor.windowIndex, lastWindowIndex),
    lastTradeId:
      trades.length === 0
        ? cursor.lastTradeId
        : (trades[trades.length - 1] as ReplayTrade).tradeId,
    lastEventTime:
      trades.length === 0 ? cursor.lastEventTime : maxEventTime(trades),
  }
  return {
    trades,
    cursor: finalCursor,
    gaps,
    conflicts,
    duplicateCount,
    attempts,
  }
}

interface GapDetectionInput {
  readonly tradeIds: readonly number[]
  readonly tradesByTradeId: ReadonlyMap<number, ReplayTrade>
  readonly windowByTradeId: ReadonlyMap<number, BackfillWindow>
  readonly rest: BackfillSource | undefined
  readonly cursor: BackfillCursor
  readonly fetchPage: (
    source: BackfillSource,
    request: Omit<BackfillSourceRequest, 'attempt'>,
  ) => Promise<BackfillSourcePage>
  readonly mergeTrade: (trade: ReplayTrade, window: BackfillWindow) => void
  readonly clock: () => TimestampMs
}

async function detectGaps(
  input: GapDetectionInput,
): Promise<readonly BackfillGapEvidence[]> {
  const gaps: BackfillGapEvidence[] = []
  for (let index = 1; index < input.tradeIds.length; index += 1) {
    const previousTradeId = input.tradeIds[index - 1] as number
    const nextTradeId = input.tradeIds[index] as number
    if (nextTradeId - previousTradeId <= 1) continue
    const missingTradeIds: number[] = []
    for (let id = previousTradeId + 1; id < nextTradeId; id += 1)
      missingTradeIds.push(id)
    const previous = input.tradesByTradeId.get(previousTradeId) as ReplayTrade
    const next = input.tradesByTradeId.get(nextTradeId) as ReplayTrade
    const window = input.windowByTradeId.get(previousTradeId) as BackfillWindow
    let resolution: GapResolution = 'unresolved'
    if (input.rest !== undefined) {
      try {
        const restWindow: BackfillWindow = {
          index: window.index,
          startTime: previous.eventTime,
          endTime: next.eventTime,
        }
        const page = await input.fetchPage(input.rest, {
          window: restWindow,
          cursor: input.cursor,
          sinceTradeId: previousTradeId,
        })
        for (const trade of page.trades) input.mergeTrade(trade, restWindow)
        if (missingTradeIds.every((id) => input.tradesByTradeId.has(id)))
          resolution = 'rest_catch_up'
      } catch {
        resolution = 'unresolved'
      }
    }
    gaps.push({
      kind: 'trade_id',
      window,
      previousTradeId,
      nextTradeId,
      missingTradeIds,
      detectedAt: input.clock(),
      resolved: resolution === 'rest_catch_up',
      resolution,
    })
  }
  return gaps
}

function validateWindows(windows: readonly BackfillWindow[]): void {
  let previous: BackfillWindow | undefined
  for (const window of windows) {
    if (
      !Number.isSafeInteger(window.index) ||
      window.index < 0 ||
      window.startTime >= window.endTime
    )
      throw new ReplayImportError(
        'invalid_windows',
        'Backfill windows must be ordered, non-empty epoch ranges.',
      )
    if (previous !== undefined) {
      if (window.index <= previous.index || window.startTime < previous.endTime)
        throw new ReplayImportError(
          'invalid_windows',
          'Backfill windows must be ordered and non-overlapping.',
        )
    }
    previous = window
  }
}

function sameTrade(left: ReplayTrade, right: ReplayTrade): boolean {
  return (
    left.price === right.price &&
    left.qty === right.qty &&
    left.side === right.side &&
    left.eventTime === right.eventTime &&
    (left.orderType ?? null) === (right.orderType ?? null)
  )
}

function maxTradeId(trades: readonly ReplayTrade[]): number | null {
  if (trades.length === 0) return null
  return trades.reduce(
    (highest, trade) => Math.max(highest, trade.tradeId),
    trades[0]?.tradeId ?? 0,
  )
}

function maxEventTime(trades: readonly ReplayTrade[]): TimestampMs | null {
  if (trades.length === 0) return null
  return trades.reduce<TimestampMs>(
    (highest, trade) => (trade.eventTime > highest ? trade.eventTime : highest),
    trades[0]?.eventTime ?? (0 as TimestampMs),
  )
}
