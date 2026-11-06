/**
 * Retention defaults and the capture's "save less" switches (docs/operacion-base-de-datos.md).
 *
 * Retention: tickers and the duplicate raw copy inside `normalized_json` are kept 48 h (they were
 * 24 h) so that one daily copy of the database still holds the whole previous day for the Parquet
 * archive; trades/books keep their 7 days.
 *
 * Switches: every one is OFF unless its variable says `1`/`true`/`on`/`yes`. Off means the capture
 * writes exactly what it always wrote. The one exception is the funding response body
 * (`FUTURES_FUNDING_BODY`): since 2026-11 it is NOT kept by default (S6 of odd/tasks/datos-utiles.md).
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
  /**
   * Funding responses: never the full body. The row (the periods' foreign key points at it) keeps the
   * body's hash and size and the literal text of the periods that were new (`fundingSlimBody`).
   * Wins over `fundingBodyDaily`. If the literals cannot be isolated the full body is kept anyway.
   */
  readonly fundingBodyNone?: boolean
  /** Analytics responses: the row (needed by the points' foreign key) keeps hash and size, not the body. */
  readonly analyticsRawSlim: boolean
  /** Candle revisions: once settled, a candle keeps its first, last and closed revisions. */
  readonly candleCompaction?: { readonly settleMs: number }
}

export type FundingBodyMode = 'none' | 'daily' | 'full'

/**
 * `FUTURES_FUNDING_BODY` = `none` (default) | `daily` | `full`. Unset, the legacy
 * `FUTURES_FUNDING_BODY_DAILY=1` still means `daily`; an unknown value means `none`.
 */
export function fundingBodyModeFromEnv(env: Env): FundingBodyMode {
  const value = env.FUTURES_FUNDING_BODY?.trim().toLowerCase()
  if (value === 'none' || value === 'daily' || value === 'full') return value
  if (value === undefined || value === '')
    return switchOn(env, 'FUTURES_FUNDING_BODY_DAILY') ? 'daily' : 'none'
  return 'none'
}

export function captureSavingsFromEnv(env: Env): CaptureSavings {
  const fundingBody = fundingBodyModeFromEnv(env)
  return {
    fundingBodyDaily: fundingBody === 'daily',
    fundingBodyNone: fundingBody === 'none',
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
