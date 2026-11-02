/**
 * Retention defaults and the capture's "save less" switches (docs/operacion-base-de-datos.md).
 *
 * Retention: tickers and the duplicate raw copy inside `normalized_json` are kept 48 h (they were
 * 24 h) so that one daily copy of the database still holds the whole previous day for the Parquet
 * archive; trades/books keep their 7 days.
 *
 * Switches: every one is OFF unless its variable says `1`/`true`/`on`/`yes`. Off means the capture
 * writes exactly what it always wrote.
 */
export const DEFAULT_TICKER_RETENTION_HOURS = 48
export const DEFAULT_EVENT_RETENTION_DAYS = 7
export const DEFAULT_RAW_COPY_KEEP_HOURS = 48
export const DEFAULT_CANDLE_SETTLE_HOURS = 6

const HOUR = 3_600_000

export interface RetentionMs {
  readonly tickerRetentionMs: number
  readonly eventRetentionMs: number
  readonly rawKeepMs: number
}

type Env = Readonly<Record<string, string | undefined>>

function positive(env: Env, name: string, fallback: number): number {
  const value = Number(env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function retentionFromEnv(env: Env): RetentionMs {
  return {
    tickerRetentionMs:
      positive(
        env,
        'FUTURES_TICKER_RETENTION_HOURS',
        DEFAULT_TICKER_RETENTION_HOURS,
      ) * HOUR,
    eventRetentionMs:
      positive(
        env,
        'FUTURES_EVENT_RETENTION_DAYS',
        DEFAULT_EVENT_RETENTION_DAYS,
      ) *
      24 *
      HOUR,
    rawKeepMs:
      positive(
        env,
        'FUTURES_RAW_COPY_KEEP_HOURS',
        DEFAULT_RAW_COPY_KEEP_HOURS,
      ) * HOUR,
  }
}

export function switchOn(env: Env, name: string): boolean {
  return /^(1|true|on|yes)$/i.test(env[name]?.trim() ?? '')
}

export interface CaptureSavings {
  /** Funding responses: full body once per UTC day and product; the other new periods keep only their own lines. */
  readonly fundingBodyDaily: boolean
  /** Analytics responses: the row (needed by the points' foreign key) keeps hash and size, not the body. */
  readonly analyticsRawSlim: boolean
  /** Candle revisions: once settled, a candle keeps its first, last and closed revisions. */
  readonly candleCompaction?: { readonly settleMs: number }
}

export function captureSavingsFromEnv(env: Env): CaptureSavings {
  return {
    fundingBodyDaily: switchOn(env, 'FUTURES_FUNDING_BODY_DAILY'),
    analyticsRawSlim: switchOn(env, 'FUTURES_ANALYTICS_RAW_SLIM'),
    ...(switchOn(env, 'FUTURES_CANDLE_REVISIONS_COMPACT')
      ? {
          candleCompaction: {
            settleMs:
              positive(
                env,
                'FUTURES_CANDLE_REVISIONS_SETTLE_HOURS',
                DEFAULT_CANDLE_SETTLE_HOURS,
              ) * HOUR,
          },
        }
      : {}),
  }
}
