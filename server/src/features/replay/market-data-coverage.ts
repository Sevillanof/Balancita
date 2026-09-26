import type { DatabaseSync } from 'node:sqlite'

export type CoverageStatus =
  | 'missing'
  | 'insufficient'
  | 'unverified'
  | 'available'
  | 'stale'
  | 'future_dated'

export interface ObservationCoverage {
  readonly source: 'kraken_market_observations'
  readonly count: number
  readonly firstEventTime: number | null
  readonly lastEventTime: number | null
  readonly firstReceivedTime: number | null
  readonly maxReceivedTime: number | null
  readonly ageMs: number | null
  readonly receiveAgeMs: number | null
  readonly timeSpanMs: number
  readonly clockInverted: boolean
  readonly gaps: {
    readonly status: 'not_measured'
    readonly reason: string
  }
  readonly spanAdequacy: 'insufficient' | 'sufficient'
  readonly completeness: 'unknown'
  readonly coverageAdequacy: 'missing' | 'insufficient' | 'unknown'
  readonly freshnessStatus: 'unknown' | 'fresh' | 'stale' | 'future_dated'
  readonly status: CoverageStatus
  readonly reason: string | null
}

export interface OhlcCoverage {
  readonly source: 'kraken_rest_ohlc_1m'
  readonly count: number
  readonly firstEventTime: number | null
  readonly lastEventTime: number | null
  readonly ageMs: number | null
  readonly timeSpanMs: number
  readonly gapCount: number | null
  readonly clockInverted: boolean
  readonly spanAdequacy: 'insufficient' | 'sufficient'
  readonly coverageAdequacy: 'missing' | 'insufficient' | 'adequate' | 'unknown'
  readonly freshnessStatus: 'unknown' | 'fresh' | 'stale' | 'future_dated'
  readonly status: CoverageStatus
  readonly reason: string | null
}

export interface MarketDataCoverage {
  readonly measuredAt: number
  readonly staleAfterMs: number
  readonly minimumCoverageMs: number
  readonly observations: ObservationCoverage
  readonly ohlc: OhlcCoverage
}

type Row = Record<string, unknown>

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** Aggregate-only read path. It never returns raw rows or changes database state. */
export function readMarketDataCoverage(
  database: Pick<DatabaseSync, 'prepare'>,
  measuredAt: number,
  options: {
    readonly staleAfterMs?: number
    readonly minimumCoverageMs?: number
  } = {},
): MarketDataCoverage {
  const staleAfterMs = options.staleAfterMs ?? 120_000
  const minimumCoverageMs = options.minimumCoverageMs ?? ONE_YEAR_MS
  for (const [name, value] of [
    ['measurement time', measuredAt],
    ['stale threshold', staleAfterMs],
    ['minimum coverage span', minimumCoverageMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Coverage ${name} must be a non-negative safe integer.`)
  }

  const hasObservations = tableExists(database, 'market_observations')
  const hasOhlc = tableExists(database, 'candles_1m_kraken')
  const observationSummary = hasObservations
    ? (database
        .prepare(
          `SELECT COUNT(*) AS count, MIN(event_time) AS first_event_time,
                  MAX(event_time) AS last_event_time, MAX(received_time) AS max_received_time,
                  (SELECT received_time FROM market_observations
                    WHERE source = 'kraken' AND instrument_id = 'BTC-EUR'
                    ORDER BY event_time, rowid LIMIT 1) AS first_received_time
             FROM market_observations
            WHERE source = 'kraken' AND instrument_id = 'BTC-EUR'`,
        )
        .get() as Row)
    : undefined

  const ohlcSummary = hasOhlc
    ? (database
        .prepare(
          `WITH ordered AS (
             SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp) AS previous_timestamp
               FROM candles_1m_kraken
           )
           SELECT COUNT(*) AS count, MIN(timestamp) AS first_timestamp,
                  MAX(timestamp) AS last_timestamp,
                  SUM(CASE WHEN timestamp - previous_timestamp > 60 THEN 1 ELSE 0 END) AS gap_count
             FROM ordered`,
        )
        .get() as Row)
    : undefined

  const observations = summarizeObservations(
    observationSummary,
    measuredAt,
    staleAfterMs,
    minimumCoverageMs,
    !hasObservations,
  )
  const ohlc = summarizeOhlc(
    ohlcSummary,
    measuredAt,
    staleAfterMs,
    minimumCoverageMs,
    !hasOhlc,
  )
  return {
    measuredAt,
    staleAfterMs,
    minimumCoverageMs,
    observations,
    ohlc,
  }
}

function tableExists(
  database: Pick<DatabaseSync, 'prepare'>,
  table: string,
): boolean {
  return (
    database
      .prepare(
        'SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ?',
      )
      .get('table', table) !== undefined
  )
}

function summarizeObservations(
  row: Row | undefined,
  measuredAt: number,
  staleAfterMs: number,
  minimumCoverageMs: number,
  schemaMissing: boolean,
): ObservationCoverage {
  const count = schemaMissing ? 0 : Number(row?.count ?? 0)
  const firstEventTime = nullableNumber(row?.first_event_time)
  const lastEventTime = nullableNumber(row?.last_event_time)
  const firstReceivedTime = nullableNumber(row?.first_received_time)
  const maxReceivedTime = nullableNumber(row?.max_received_time)
  const rawAgeMs = lastEventTime === null ? null : measuredAt - lastEventTime
  const clockInverted =
    (rawAgeMs !== null && rawAgeMs < 0) ||
    (maxReceivedTime !== null && maxReceivedTime > measuredAt)
  const ageMs = rawAgeMs === null ? null : Math.max(0, rawAgeMs)
  const receiveAgeMs =
    maxReceivedTime === null ? null : Math.max(0, measuredAt - maxReceivedTime)
  const timeSpanMs =
    firstEventTime === null || lastEventTime === null
      ? 0
      : lastEventTime - firstEventTime
  const coverageAdequacy: ObservationCoverage['coverageAdequacy'] =
    count === 0
      ? 'missing'
      : timeSpanMs < minimumCoverageMs
        ? 'insufficient'
        : 'unknown'
  const status = statusFor({
    count,
    ageMs,
    clockInverted,
    staleAfterMs,
    coverageAdequacy,
  })
  return {
    source: 'kraken_market_observations',
    count,
    firstEventTime,
    lastEventTime,
    firstReceivedTime,
    maxReceivedTime,
    ageMs,
    receiveAgeMs,
    timeSpanMs,
    clockInverted,
    gaps: {
      status: 'not_measured',
      reason:
        'Trade observations are irregular; this read path has no trustworthy trade-ID gap evidence.',
    },
    spanAdequacy: spanAdequacyFor(timeSpanMs, minimumCoverageMs),
    completeness: 'unknown',
    coverageAdequacy,
    freshnessStatus: freshnessFor(count, ageMs, clockInverted, staleAfterMs),
    status: schemaMissing ? 'missing' : status,
    reason: schemaMissing
      ? 'Observation table is absent in this database snapshot; no migration was run.'
      : statusReason(status, timeSpanMs, minimumCoverageMs, ageMs),
  }
}

function summarizeOhlc(
  row: Row | undefined,
  measuredAt: number,
  staleAfterMs: number,
  minimumCoverageMs: number,
  schemaMissing: boolean,
): OhlcCoverage {
  const count = schemaMissing ? 0 : Number(row?.count ?? 0)
  const firstSeconds = nullableNumber(row?.first_timestamp)
  const lastSeconds = nullableNumber(row?.last_timestamp)
  const firstEventTime = firstSeconds === null ? null : firstSeconds * 1000
  const lastEventTime = lastSeconds === null ? null : lastSeconds * 1000
  const rawAgeMs = lastEventTime === null ? null : measuredAt - lastEventTime
  const clockInverted = rawAgeMs !== null && rawAgeMs < 0
  const ageMs = rawAgeMs === null ? null : Math.max(0, rawAgeMs)
  const timeSpanMs =
    firstEventTime === null || lastEventTime === null
      ? 0
      : lastEventTime - firstEventTime
  const gapCount = schemaMissing ? null : Number(row?.gap_count ?? 0)
  const coverageAdequacy = ohlcAdequacy(
    count,
    timeSpanMs,
    minimumCoverageMs,
    gapCount,
    schemaMissing,
  )
  const status = statusFor({
    count,
    ageMs,
    clockInverted,
    staleAfterMs,
    coverageAdequacy,
  })
  return {
    source: 'kraken_rest_ohlc_1m',
    count,
    firstEventTime,
    lastEventTime,
    ageMs,
    timeSpanMs,
    gapCount,
    clockInverted,
    spanAdequacy: spanAdequacyFor(timeSpanMs, minimumCoverageMs),
    coverageAdequacy,
    freshnessStatus: freshnessFor(count, ageMs, clockInverted, staleAfterMs),
    status: schemaMissing ? 'missing' : status,
    reason: schemaMissing
      ? 'OHLC table is absent in this database snapshot; no migration was run.'
      : statusReason(status, timeSpanMs, minimumCoverageMs, ageMs, gapCount),
  }
}

function spanAdequacyFor(
  timeSpanMs: number,
  minimumCoverageMs: number,
): 'insufficient' | 'sufficient' {
  return timeSpanMs < minimumCoverageMs ? 'insufficient' : 'sufficient'
}

function ohlcAdequacy(
  count: number,
  timeSpanMs: number,
  minimumCoverageMs: number,
  gapCount: number | null,
  schemaMissing: boolean,
): 'missing' | 'insufficient' | 'adequate' | 'unknown' {
  if (schemaMissing || count === 0) return 'missing'
  if (gapCount === null) return 'unknown'
  if (timeSpanMs < minimumCoverageMs || gapCount > 0) return 'insufficient'
  return 'adequate'
}

function freshnessFor(
  count: number,
  ageMs: number | null,
  clockInverted: boolean,
  staleAfterMs: number,
): 'unknown' | 'fresh' | 'stale' | 'future_dated' {
  if (count === 0 || ageMs === null) return 'unknown'
  if (clockInverted) return 'future_dated'
  return ageMs > staleAfterMs ? 'stale' : 'fresh'
}

function statusFor(input: {
  readonly count: number
  readonly ageMs: number | null
  readonly clockInverted: boolean
  readonly staleAfterMs: number
  readonly coverageAdequacy:
    ObservationCoverage['coverageAdequacy'] | OhlcCoverage['coverageAdequacy']
}): CoverageStatus {
  if (input.count === 0) return 'missing'
  if (input.coverageAdequacy === 'insufficient') return 'insufficient'
  if (input.clockInverted) return 'future_dated'
  if (input.ageMs !== null && input.ageMs > input.staleAfterMs) return 'stale'
  if (input.coverageAdequacy === 'unknown') return 'unverified'
  return 'available'
}

function statusReason(
  status: CoverageStatus,
  timeSpanMs: number,
  minimumCoverageMs: number,
  ageMs: number | null,
  gapCount: number | null = null,
): string | null {
  if (status === 'stale') return `Latest event is ${ageMs}ms old.`
  if (status === 'future_dated')
    return 'Snapshot clock precedes an event or receive timestamp.'
  if (status === 'unverified')
    return 'Stored evidence cannot establish source completeness.'
  if (status === 'insufficient' && gapCount !== null && gapCount > 0)
    return `Coverage contains ${gapCount} internal gap(s); continuity is not established.`
  if (status === 'insufficient')
    return `Coverage spans ${timeSpanMs}ms; ${minimumCoverageMs}ms is required.`
  if (status === 'missing') return 'No records are available for this source.'
  return null
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}
