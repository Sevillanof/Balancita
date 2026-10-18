// Funding rate captured in real time from the Kraken Futures WebSocket ticker
// (#184). Bitcoin only for now. The ticker carries, for the CURRENT hourly
// period, `funding_rate` (absolute USD per contract per hour) and
// `relative_funding_rate`, and, for the NEXT period, the `*_prediction` pair,
// which Kraken documents as potentially very inaccurate. Predictions are
// stored under their own labelled columns and are never read as a rate.
// Kraken omits zero-valued fields: an omitted field is stored as the explicit
// text '0', never as "missing".

/** An `alive` mark is written at most this often while ticker frames arrive. */
export const FUNDING_WS_ALIVE_MARK_INTERVAL_MS = 30_000
/**
 * PROVISIONAL (3 alive intervals): the latest mark before the close must be an
 * `alive` mark at most this old, otherwise the socket is not proven to have
 * been up at the close and the WS rate of that period does not exist.
 */
export const FUNDING_WS_COVERAGE_MAX_SILENCE_MS = 90_000
export const FUNDING_PERIOD_MS = 3_600_000

export interface FundingWsObservation {
  readonly productId: string
  /** Local receive time (collector clock), ms. */
  readonly receivedAt: number
  /** Provider `time` of the ticker frame, ms (diagnostic only). */
  readonly eventTime: number
  /** Collector clock at socket open: identifies one continuous connection. */
  readonly connectedAt: number
  readonly firstAfterConnect: boolean
  /** Rate of the current period (absolute USD/contract/hour), decimal text. */
  readonly fundingRate: string
  readonly relativeFundingRate: string
  /** PREDICTION for the next period. Never a rate. */
  readonly fundingRatePrediction: string
  readonly relativeFundingRatePrediction: string
  /** End of the current period, ms epoch; 0 when the frame omitted it. */
  readonly nextFundingRateTime: number
}

export type FundingWsMarkKind = 'alive' | 'closed'

export interface FundingWsMark {
  readonly productId: string
  readonly at: number
  readonly connectedAt: number
  readonly kind: FundingWsMarkKind
}

/** Why a period has no WS rate (REST backfill and sightings stay the fallback). */
export type FundingWsRateResult =
  | {
      readonly status: 'ok'
      readonly fundingRate: string
      readonly relativeFundingRate: string
      readonly observedAt: number
      readonly connectedAt: number
    }
  | {
      readonly status: 'unavailable'
      readonly reason:
        | 'no_table'
        | 'no_observation'
        | 'no_coverage'
        | 'connection_mismatch'
        | 'period_mismatch'
    }

export interface FundingWsComparison {
  readonly compared: number
  readonly matched: number
  readonly mismatched: number
  /** Periods with a WS rate and no REST sighting, and the reverse. */
  readonly onlyWs: number
  readonly onlyRest: number
  readonly mismatches: readonly {
    readonly startMs: number
    readonly ws: string
    readonly rest: string
  }[]
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

function field(item: Record<string, unknown>, name: string): string {
  const value = item[name]
  // Kraken omits zero-valued fields: omitted means exactly zero.
  if (value === undefined) return '0'
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new TypeError(`ticker ${name} must be a decimal.`)
  const text = String(value)
  if (text.length > 128 || !DECIMAL.test(text))
    throw new TypeError(`ticker ${name} must be a bounded finite decimal.`)
  return text
}

/**
 * Funding fields of one decoded ticker frame (numbers arrive as source
 * lexemes, see `decodeProviderJson`). Malformed fields throw.
 */
export function fundingObservationFromTicker(
  item: Record<string, unknown>,
  context: {
    readonly productId: string
    readonly receivedAt: number
    readonly connectedAt: number
    readonly firstAfterConnect: boolean
  },
): FundingWsObservation {
  const nextMs = Number(field(item, 'next_funding_rate_time'))
  if (!Number.isSafeInteger(nextMs) || nextMs < 0)
    throw new TypeError('ticker next_funding_rate_time must be epoch ms.')
  const eventTime = Number(field(item, 'time'))
  if (!Number.isSafeInteger(eventTime) || eventTime < 0)
    throw new TypeError('ticker time must be epoch ms.')
  return {
    productId: context.productId,
    receivedAt: context.receivedAt,
    eventTime,
    connectedAt: context.connectedAt,
    firstAfterConnect: context.firstAfterConnect,
    fundingRate: field(item, 'funding_rate'),
    relativeFundingRate: field(item, 'relative_funding_rate'),
    fundingRatePrediction: field(item, 'funding_rate_prediction'),
    relativeFundingRatePrediction: field(
      item,
      'relative_funding_rate_prediction',
    ),
    nextFundingRateTime: nextMs,
  }
}

/** Observations repeat while nothing changes: only these five values count. */
export function fundingChangeKey(o: FundingWsObservation): string {
  return [
    o.fundingRate,
    o.relativeFundingRate,
    o.fundingRatePrediction,
    o.relativeFundingRatePrediction,
    o.nextFundingRateTime,
  ].join('|')
}
