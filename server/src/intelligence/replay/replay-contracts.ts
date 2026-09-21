import type { TimestampMs } from '../contracts.ts'
import type { CandleInterval } from '../market/intraday-candles.ts'
import type { TradeSide } from '../market/market-payload.ts'

export const REPLAY_INSTRUMENT = 'BTC-EUR' as const

export const REPLAY_SOURCE = 'kraken' as const

export type ReplayTradeOrigin = 'archive' | 'rest'

/**
 * A single Kraken trade normalized for the historical replay pipeline. Event
 * time is the provider-reported instant; received time is when the local
 * process parsed the row. `origin` distinguishes the frozen archive from REST
 * catch-up evidence.
 */
export interface ReplayTrade {
  readonly instrumentId: 'BTC-EUR'
  readonly source: 'kraken'
  readonly tradeId: number
  readonly eventTime: TimestampMs
  readonly receivedTime: TimestampMs
  readonly price: number
  readonly qty: number
  readonly side: TradeSide
  readonly orderType?: 'limit' | 'market'
  readonly origin: ReplayTradeOrigin
}

export interface BackfillWindow {
  readonly index: number
  readonly startTime: TimestampMs
  readonly endTime: TimestampMs
}

export interface BackfillCursor {
  readonly windowIndex: number
  readonly lastTradeId: number | null
  readonly lastEventTime: TimestampMs | null
}

export interface BackfillSourceRequest {
  readonly window: BackfillWindow
  readonly cursor: BackfillCursor
  readonly attempt: number
  readonly sinceTradeId?: number
}

export interface BackfillSourcePage {
  readonly trades: readonly ReplayTrade[]
  readonly hasMore: boolean
}

/**
 * A cursor-based fetch source. The archive source is the frozen download; the
 * REST source is the public `/0/public/Trades` catch-up used only to recover
 * detected gaps.
 */
export interface BackfillSource {
  readonly origin: ReplayTradeOrigin
  fetchPage(request: BackfillSourceRequest): Promise<BackfillSourcePage>
}

export type GapResolution = 'rest_catch_up' | 'unresolved'

export interface BackfillGapEvidence {
  readonly kind: 'trade_id'
  readonly window: BackfillWindow
  readonly previousTradeId: number
  readonly nextTradeId: number
  readonly missingTradeIds: readonly number[]
  readonly detectedAt: TimestampMs
  readonly resolved: boolean
  readonly resolution: GapResolution
}

export interface BackfillConflictEvidence {
  readonly tradeId: number
  readonly window: BackfillWindow
  readonly existing: ReplayTrade
  readonly incoming: ReplayTrade
  readonly detectedAt: TimestampMs
}

export interface BackfillImportResult {
  readonly trades: readonly ReplayTrade[]
  readonly cursor: BackfillCursor
  readonly gaps: readonly BackfillGapEvidence[]
  readonly conflicts: readonly BackfillConflictEvidence[]
  readonly duplicateCount: number
  readonly attempts: number
}

export interface ReplayDatasetCandle {
  readonly interval: CandleInterval
  readonly bucketStart: TimestampMs
  readonly bucketEnd: TimestampMs
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly tradeCount: number
  readonly firstTradeId: number
  readonly lastTradeId: number
  readonly eventTimeStart: TimestampMs
  readonly eventTimeEnd: TimestampMs
  readonly isClosed: boolean
}

export interface FrozenReplayDataset {
  readonly instrumentId: 'BTC-EUR'
  readonly source: 'kraken'
  readonly importVersion: string
  readonly interval: CandleInterval
  readonly asOfTimestamp: TimestampMs
  readonly candles: readonly ReplayDatasetCandle[]
  readonly gapEvidence: readonly BackfillGapEvidence[]
  readonly conflictEvidence: readonly BackfillConflictEvidence[]
  readonly datasetHash: string
}

export type ReplayImportErrorCode =
  'invalid_windows' | 'archive_fetch_failed' | 'invalid_archive_row'

export class ReplayImportError extends Error {
  readonly code: ReplayImportErrorCode

  constructor(
    code: ReplayImportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ReplayImportError'
    this.code = code
  }
}

export type ReplayDatasetFreezeErrorCode =
  | 'conflicting_duplicate'
  | 'unresolved_gap'
  | 'empty_dataset'
  | 'invalid_interval'
  | 'invalid_import_version'

export class ReplayDatasetFreezeError extends Error {
  readonly code: ReplayDatasetFreezeErrorCode

  constructor(
    code: ReplayDatasetFreezeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ReplayDatasetFreezeError'
    this.code = code
  }
}
