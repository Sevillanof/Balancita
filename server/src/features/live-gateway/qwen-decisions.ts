import { withDb, num, rowOf, type Row } from './observability-health.ts'

/**
 * Qwen operador en vivo, solo lectura: sus decisiones (una por producto cada
 * 15 minutos) y sus operaciones de papel, leídas de la base propia del proceso
 * `futures_qwen_live` (`QWEN_LIVE_DB_PATH`). LARGO = LONG, CORTO = SHORT,
 * ESPERAR y MANTENER = WAIT, CERRAR = CLOSE. Nada de esto escribe, lanza ni
 * infiere: una fuente que no se puede leer dice por qué.
 */
const PRODUCT = /^PF_[A-Z0-9]{2,16}$/
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const SKIPPED_LIMIT = 20
const ACTIONS: Record<string, QwenAction> = {
  LARGO: 'LONG',
  CORTO: 'SHORT',
  ESPERAR: 'WAIT',
  MANTENER: 'WAIT',
  CERRAR: 'CLOSE',
}

export type QwenAction = 'LONG' | 'SHORT' | 'WAIT' | 'CLOSE'

export interface QwenDecision {
  readonly product: string
  /** Start of the 15 minute window this decision closes. */
  readonly bucket_start_ms: number
  /** The instant of the market it read (the end of that window). */
  readonly decision_time_ms: number
  readonly action: QwenAction
  /** What Qwen did, in its own words: LARGO, CORTO, ESPERAR, MANTENER or CERRAR. */
  readonly chosen: string
  readonly confidence: number
  readonly latency_ms: number
  readonly written_at_ms: number
  readonly question_version: number
  readonly reason: string | null
}

/** A wake that was not decided (model down or slow, process off). */
export interface QwenSkipped {
  readonly product: string
  readonly bucket_start_ms: number
  readonly decision_time_ms: number
  readonly reason: string
  readonly detail: string
}

export interface QwenTrade {
  readonly product: string
  readonly trade_no: number
  readonly status: 'open' | 'closed'
  readonly side: 'LONG' | 'SHORT'
  readonly entry_ms: number
  readonly exit_ms: number | null
  readonly entry_price: string | null
  readonly exit_price: string | null
  readonly quantity: string | null
  readonly notional_usd: string | null
  readonly leverage: string | null
  readonly margin_usd: string | null
  readonly gross_usd: string | null
  readonly fees_usd: string | null
  readonly funding_usd: string | null
  readonly funding_status: string | null
  /** Closed: the final net. Open: what closing now would net (costs included). */
  readonly net_usd: string | null
  readonly closed_by: string | null
  readonly exit_reason: string | null
  readonly hold_min: number | null
  readonly mark_price: number | null
  readonly mark_ms: number | null
}

export type QwenDecisionsResponse =
  | {
      readonly status: 'ok'
      readonly decisions: readonly QwenDecision[]
      readonly skipped: readonly QwenSkipped[]
    }
  | { readonly status: 'off' | 'error'; readonly reason: string }

export type QwenTradesResponse =
  | { readonly status: 'ok'; readonly trades: readonly QwenTrade[] }
  | { readonly status: 'off' | 'error'; readonly reason: string }

export interface QwenDecisions {
  report(product: string, limit?: number): QwenDecisionsResponse
  trades(product: string, limit?: number): QwenTradesResponse
}

export function qwenDecisionsOff(reason: string): QwenDecisions {
  return {
    report: () => ({ status: 'off', reason }),
    trades: () => ({ status: 'off', reason }),
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

export function createQwenDecisions(options: {
  readonly liveDbPath: string | undefined
}): QwenDecisions {
  const invalid = (
    product: string,
    limit: number,
  ): { status: 'error'; reason: string } | null => {
    if (!PRODUCT.test(product))
      return { status: 'error', reason: 'invalid_product' }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
      return { status: 'error', reason: 'invalid_limit' }
    return null
  }
  return {
    report(product, limit = DEFAULT_LIMIT) {
      const bad = invalid(product, limit)
      if (bad) return bad
      const opened = withDb(options.liveDbPath, (db) => ({
        decisions: db
          .prepare(
            `SELECT bucket_ms, t_ms, decided_at_ms, action, confidence, latency_ms, prompt_version, reason
               FROM decisions WHERE product=? ORDER BY bucket_ms DESC LIMIT ?`,
          )
          .all(product, limit)
          .map((row) => rowOf(row)),
        skipped: db
          .prepare(
            `SELECT bucket_ms, t_ms, reason, detail
               FROM skipped WHERE product=? ORDER BY bucket_ms DESC LIMIT ?`,
          )
          .all(product, SKIPPED_LIMIT)
          .map((row) => rowOf(row)),
      }))
      if (opened.state !== 'read')
        return { status: 'off', reason: opened.detail }
      const decisions: QwenDecision[] = []
      for (const row of opened.value.decisions as Row[]) {
        const bucket = num(row.bucket_ms)
        const chosen = String(row.action)
        const action = ACTIONS[chosen]
        if (bucket === null || !action) continue
        const written = num(row.decided_at_ms) ?? bucket
        decisions.push({
          product,
          bucket_start_ms: bucket,
          decision_time_ms: num(row.t_ms) ?? written,
          action,
          chosen,
          confidence: num(row.confidence) ?? 0,
          latency_ms: num(row.latency_ms) ?? 0,
          written_at_ms: written,
          question_version: num(row.prompt_version) ?? 0,
          reason: text(row.reason),
        })
      }
      const skipped: QwenSkipped[] = []
      for (const row of opened.value.skipped as Row[]) {
        const bucket = num(row.bucket_ms)
        if (bucket === null) continue
        skipped.push({
          product,
          bucket_start_ms: bucket,
          decision_time_ms: num(row.t_ms) ?? bucket,
          reason: String(row.reason),
          detail: text(row.detail) ?? '',
        })
      }
      return { status: 'ok', decisions, skipped }
    },
    trades(product, limit = DEFAULT_LIMIT) {
      const bad = invalid(product, limit)
      if (bad) return bad
      const opened = withDb(options.liveDbPath, (db) =>
        db
          .prepare(
            `SELECT * FROM trades WHERE product=?
              ORDER BY (status='open') DESC, entry_ms DESC LIMIT ?`,
          )
          .all(product, limit)
          .map((row) => rowOf(row)),
      )
      if (opened.state !== 'read')
        return { status: 'off', reason: opened.detail }
      const trades: QwenTrade[] = []
      for (const row of opened.value as Row[]) {
        const tradeNo = num(row.trade_no)
        const entry = num(row.entry_ms)
        const side =
          row.side === 'LONG' || row.side === 'SHORT' ? row.side : null
        if (tradeNo === null || entry === null || side === null) continue
        const open = row.status === 'open'
        trades.push({
          product,
          trade_no: tradeNo,
          status: open ? 'open' : 'closed',
          side,
          entry_ms: entry,
          exit_ms: num(row.exit_ms),
          entry_price: text(row.entry_px),
          exit_price: text(row.exit_px),
          quantity: text(row.qty),
          notional_usd: text(row.notional_usd),
          leverage: text(row.leverage),
          margin_usd: text(row.margin_usd),
          gross_usd: text(row.gross_usd),
          fees_usd: text(row.fees_usd),
          funding_usd: text(row.funding_usd),
          funding_status: text(row.funding_status),
          net_usd: text(open ? row.net_now_usd : row.net_usd),
          closed_by: text(row.closed_by),
          exit_reason: text(row.exit_reason),
          hold_min: num(row.hold_min),
          mark_price: open ? num(row.mark_px) : null,
          mark_ms: open ? num(row.mark_ms) : null,
        })
      }
      return { status: 'ok', trades }
    },
  }
}
