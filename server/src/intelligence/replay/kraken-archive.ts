import type { TimestampMs } from '../contracts.ts'
import {
  ReplayImportError,
  type BackfillSource,
  type BackfillSourcePage,
  type ReplayTrade,
} from './replay-contracts.ts'

export const KRAKEN_TIME_AND_SALES_COLUMNS = [
  'timestamp',
  'price',
  'volume',
  'type',
  'order_type',
  'misc',
  'trade_id',
] as const

export interface ParseTimeAndSalesOptions {
  readonly clock: () => TimestampMs
}

/**
 * Parse a Kraken Time & Sales archive CSV. Event time comes from the archive
 * row; received time is the local parse instant supplied by the injected
 * clock. Malformed rows fail loudly rather than fabricating trades.
 */
export function parseTimeAndSalesCsv(
  csv: string,
  options: ParseTimeAndSalesOptions,
): readonly ReplayTrade[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0)
    throw new ReplayImportError('invalid_archive_row', 'Archive CSV is empty.')
  const header = splitCsvLine(lines[0] as string)
  if (header.join(',') !== KRAKEN_TIME_AND_SALES_COLUMNS.join(','))
    throw new ReplayImportError(
      'invalid_archive_row',
      'Unexpected Time & Sales header.',
    )

  const receivedTime = options.clock()
  const trades: ReplayTrade[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const columns = splitCsvLine(lines[index] as string)
    if (columns.length !== KRAKEN_TIME_AND_SALES_COLUMNS.length)
      throw new ReplayImportError(
        'invalid_archive_row',
        `Archive row ${index} has ${columns.length} columns.`,
      )
    const trade = parseArchiveRow(columns, index, receivedTime)
    trades.push(trade)
  }
  return trades
}

/**
 * Build a fixture-friendly archive source. The CSV is parsed once; pages are
 * filtered by the requested window and never fetched over the network.
 */
export function createArchiveBackfillSource(options: {
  readonly csv: string
  readonly clock: () => TimestampMs
}): BackfillSource {
  const trades = parseTimeAndSalesCsv(options.csv, { clock: options.clock })
  return {
    origin: 'archive',
    async fetchPage({ window }): Promise<BackfillSourcePage> {
      return {
        trades: trades.filter(
          (trade) =>
            trade.eventTime >= window.startTime &&
            trade.eventTime < window.endTime,
        ),
        hasMore: false,
      }
    },
  }
}

function parseArchiveRow(
  columns: readonly string[],
  index: number,
  receivedTime: TimestampMs,
): ReplayTrade {
  const eventTime = parseArchiveTimestamp(columns[0] as string)
  const price = Number(columns[1])
  const qty = Number(columns[2])
  const rawType = columns[3]
  const rawOrderType = columns[4]
  const tradeId = Number(columns[6])
  const side = rawType === 'b' ? 'buy' : rawType === 's' ? 'sell' : null
  const orderType =
    rawOrderType === 'l' ? 'limit' : rawOrderType === 'm' ? 'market' : null
  if (
    side === null ||
    orderType === null ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(qty) ||
    qty <= 0 ||
    !Number.isSafeInteger(tradeId) ||
    tradeId < 0
  )
    throw new ReplayImportError(
      'invalid_archive_row',
      `Archive row ${index} is invalid.`,
    )
  return {
    instrumentId: 'BTC-EUR',
    source: 'kraken',
    tradeId,
    eventTime,
    receivedTime,
    price,
    qty,
    side,
    orderType,
    origin: 'archive',
  }
}

function parseArchiveTimestamp(value: string): TimestampMs {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new ReplayImportError(
      'invalid_archive_row',
      'Archive timestamp must be a non-negative epoch second value.',
    )
  const milliseconds = Math.round(seconds * 1000)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new ReplayImportError(
      'invalid_archive_row',
      'Archive timestamp is out of range.',
    )
  return milliseconds as TimestampMs
}

function splitCsvLine(line: string): string[] {
  return line.split(',').map((column) => column.trim())
}
