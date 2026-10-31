import type { DatabaseSync } from 'node:sqlite'
import { withDb, num, rowOf, type Row } from './observability-health.ts'
import { addDecimal, decimalFromPython } from './decimal-string.ts'

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
const DEFAULT_START_USD = 1000
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
  /** FLAT (LARGO/CORTO/ESPERAR) or POSITION (MANTENER/CERRAR) question; null on older bases. */
  readonly kind: string | null
  /** What the model preferred before the guardrails, in its own words; null when unknown. */
  readonly model_action: string | null
  /** Probability of that preferred option (0 to 1). */
  readonly p_action: number | null
  /** Minimum probability needed to open (flat only). */
  readonly threshold: number | null
  /** Probability of each option, keyed by LARGO / CORTO / ESPERAR / MANTENER / CERRAR. */
  readonly probabilities: Record<string, number> | null
  /** Why it did NOT act although it wanted to (bajo_umbral, espejo, ...), or null. */
  readonly override: string | null
  readonly mirror_action: string | null
  readonly mirror_p: number | null
  /** Ventana de oportunidad: ventaja (p LARGO - p CORTO) con números reales y con espejo; null fuera de la ventana. */
  readonly lean: number | null
  readonly lean_m: number | null
  /** Ventaja neta (lean - lean_m) / 2; su signo es el lado y su valor absoluto el puntaje. */
  readonly lean_num: number | null
  readonly score: number | null
  /** Mejor puntaje de las miradas candidatas (espejo coincidente) de la ventana hasta esa mirada. */
  readonly best_score: number | null
  /** Número de mirada dentro de la ventana (1 = la primera). */
  readonly look_n: number | null
  /** 1 si el espejo contradice (candidato válido), 0 si no; null fuera de la ventana. */
  readonly mirror_ok: number | null
  /**
   * Ventana con la pregunta por factores (config en vivo desde la versión 5): los 8 gradientes F1..F8 (de -2 a +2) con el estado
   * real y con el espejo, y la lectura por renglón ((real - espejo) / 2, lo que viene de los números). null en bases o miradas
   * sin factores.
   */
  readonly factors: QwenFactors | null
  /** Version 9: what the FORMULAS decided (the executed action is `chosen`; `model_action` is Qwen's opinion next to it); null before. */
  readonly formula_action: string | null
  /** What the formulas saw and why they decided: maestro, puntaje, portero, volatilidad, motivo. */
  readonly formula: Record<string, unknown> | null
  /** 1 if Qwen's opinion matched the formula's action, 0 if not; null without opinion or before version 9. */
  readonly opinion_agrees: number | null
  /** Why there is no opinion (modelo_caido, modelo_lento, sin_respuesta); null otherwise. */
  readonly opinion_error: string | null
}

export interface QwenFactors {
  readonly real: readonly number[]
  readonly mirror: readonly number[]
  readonly lectura: readonly number[]
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
  readonly funding_model?: string | null
  readonly net_complete_usd?: string | null
  readonly config_hash?: string | null
  /** Closed: the final net. Open: what closing now would net (costs included). */
  readonly net_usd: string | null
  readonly closed_by: string | null
  readonly exit_reason: string | null
  readonly hold_min: number | null
  readonly mark_price: number | null
  readonly mark_ms: number | null
}

/** Last sign of life of the operator process (table `meta`); null on a base that never wrote it. */
export interface QwenHeartbeat {
  readonly heartbeat_ms: number | null
  /** Whether llama-server answered /health at the last cycle; null when unknown. */
  readonly model_ok: boolean | null
  readonly last_error_ms: number | null
  readonly model_scope?: string
  readonly data_health?: Readonly<Record<string, Row>>
  readonly pending_config?: Row
}

export type QwenDecisionsResponse =
  | {
      readonly status: 'ok'
      readonly decisions: readonly QwenDecision[]
      readonly skipped: readonly QwenSkipped[]
      readonly heartbeat: QwenHeartbeat
    }
  | { readonly status: 'off' | 'error'; readonly reason: string }

export type QwenTradesResponse =
  | { readonly status: 'ok'; readonly trades: readonly QwenTrade[] }
  | { readonly status: 'off' | 'error'; readonly reason: string }

/** One closed operation as the account sees it: the net it moved and the balance right after. */
export interface QwenAccountStep {
  readonly product: string
  readonly trade_no: number
  readonly side: 'LONG' | 'SHORT'
  readonly exit_ms: number
  readonly net_usd: number
  readonly balance_usd: number
}

export type QwenAccountResponse =
  | {
      readonly status: 'ok'
      /** Permanent account genesis; the setting is used only for unmigrated legacy databases. */
      readonly start_usd: number
      /** start + closed nets + what the open positions would net now. */
      readonly balance_usd: number
      readonly realized_usd: number
      readonly open_usd: number
      readonly open_count: number
      /** True when some operation still lacks its published funding. */
      readonly funding_incomplete: boolean
      readonly steps: readonly QwenAccountStep[]
    }
  | { readonly status: 'off' | 'error'; readonly reason: string }

export interface QwenDecisions {
  report(product: string, limit?: number): QwenDecisionsResponse
  trades(product: string, limit?: number): QwenTradesResponse
  account(): QwenAccountResponse
}

export function qwenDecisionsOff(reason: string): QwenDecisions {
  return {
    report: () => ({ status: 'off', reason }),
    trades: () => ({ status: 'off', reason }),
    account: () => ({ status: 'off', reason }),
  }
}

/** `{"real": [8], "mirror": [8], "lectura": [8]}`; anything else (an old row, a damaged value) reads as no factors. */
function factorsOf(value: unknown): QwenFactors | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null
    const line = (key: string): readonly number[] | null => {
      const list = (parsed as Record<string, unknown>)[key]
      return Array.isArray(list) &&
        list.length === 8 &&
        list.every((x) => typeof x === 'number' && Number.isFinite(x))
        ? (list as number[])
        : null
    }
    const real = line('real')
    const mirror = line('mirror')
    const lectura = line('lectura')
    return real && mirror && lectura ? { real, mirror, lectura } : null
  } catch {
    return null
  }
}

function probabilitiesOf(value: unknown): Record<string, number> | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null
    const out: Record<string, number> = {}
    for (const [key, p] of Object.entries(parsed)) {
      if (typeof p === 'number' && Number.isFinite(p)) out[key] = p
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Columns added after the first version of the base: absent ones read as NULL. */
const OPTIONAL_DECISION_COLUMNS = [
  'kind',
  'model_action',
  'p_action',
  'threshold',
  'probs_json',
  'override',
  'mirror_action',
  'mirror_p',
  'lean',
  'lean_m',
  'lean_num',
  'score',
  'best_score',
  'look_n',
  'mirror_ok',
  'factors_json',
  'formula_action',
  'formula_json',
  'opinion_agrees',
  'opinion_error',
] as const

function readMeta(db: DatabaseSync): Record<string, unknown> {
  try {
    const out: Record<string, unknown> = {}
    for (const row of db.prepare('SELECT key, value FROM meta').all()) {
      const r = rowOf(row)
      try {
        out[String(r.key)] = JSON.parse(String(r.value))
      } catch {
        // an unreadable value reads as absent
      }
    }
    return out
  } catch {
    return {}
  }
}

function heartbeatOf(meta: Record<string, unknown>): QwenHeartbeat {
  const ms = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  return {
    heartbeat_ms: ms(meta.heartbeat_ms),
    model_ok: typeof meta.model_ok === 'boolean' ? meta.model_ok : null,
    last_error_ms: ms(meta.last_error_ms),
    ...(typeof meta.model_scope === 'string'
      ? { model_scope: meta.model_scope }
      : {}),
    ...(Object.keys(meta).some((key) => key.startsWith('data_health_'))
      ? {
          data_health: Object.fromEntries(
            Object.entries(meta)
              .filter(([key]) => key.startsWith('data_health_'))
              .map(([key, value]) => [
                key.slice('data_health_'.length),
                rowOf(value),
              ]),
          ),
        }
      : {}),
    ...(meta.pending_config && typeof meta.pending_config === 'object'
      ? { pending_config: rowOf(meta.pending_config) }
      : {}),
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function optionalColumns(db: DatabaseSync): string {
  const present = new Set(
    db
      .prepare('PRAGMA table_info(decisions)')
      .all()
      .map((row) => String(rowOf(row).name)),
  )
  return OPTIONAL_DECISION_COLUMNS.map((name) =>
    present.has(name) ? `, ${name}` : `, NULL AS ${name}`,
  ).join('')
}

export function createQwenDecisions(options: {
  readonly liveDbPath: string | undefined
  /** Legacy read-only fallback only. An initialized account always owns its capital. */
  readonly startUsd?: number
}): QwenDecisions {
  const startUsd = options.startUsd ?? DEFAULT_START_USD
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
            `SELECT bucket_ms, t_ms, decided_at_ms, action, confidence, latency_ms, prompt_version, reason${optionalColumns(db)}
               FROM decisions WHERE product=? ORDER BY bucket_ms DESC LIMIT ?`,
          )
          .all(product, limit)
          .map((row) => rowOf(row)),
        meta: readMeta(db),
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
          kind: text(row.kind),
          model_action: text(row.model_action),
          p_action: num(row.p_action),
          threshold: num(row.threshold),
          probabilities: probabilitiesOf(row.probs_json),
          override: text(row.override),
          mirror_action: text(row.mirror_action),
          mirror_p: num(row.mirror_p),
          lean: num(row.lean),
          lean_m: num(row.lean_m),
          lean_num: num(row.lean_num),
          score: num(row.score),
          best_score: num(row.best_score),
          look_n: num(row.look_n),
          mirror_ok: num(row.mirror_ok),
          factors: factorsOf(row.factors_json),
          formula_action: text(row.formula_action),
          formula: objectOf(row.formula_json),
          opinion_agrees: num(row.opinion_agrees),
          opinion_error: text(row.opinion_error),
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
      return {
        status: 'ok',
        decisions,
        skipped,
        heartbeat: heartbeatOf(opened.value.meta),
      }
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
        if (row.status !== 'open' && row.status !== 'closed')
          return { status: 'error', reason: 'invalid_trade_status' }
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
          funding_model: text(row.funding_model),
          net_complete_usd:
            row.funding_status === 'complete'
              ? text(row.net_complete_usd)
              : null,
          config_hash: text(row.config_hash),
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
    account() {
      const opened = withDb(options.liveDbPath, (db) => {
        const money = (value: unknown, field: string): string => {
          const out = decimalFromPython(value)
          if (out === null) throw new Error(`account_invalid_${field}`)
          return out
        }
        const sum = (left: string, right: string): string => {
          const out = addDecimal(left, right)
          if (out === null) throw new Error('account_invalid_total')
          return out
        }
        const display = (value: string): number => {
          const out = Number(value)
          if (!Number.isFinite(out))
            throw new Error('account_amount_out_of_range')
          return out
        }
        const hasAccount = db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='account'",
          )
          .get()
        const saved = hasAccount
          ? db.prepare('SELECT initial_usd FROM account WHERE id=1').get()
          : undefined
        if (hasAccount && saved === undefined)
          throw new Error('account_not_initialized')
        const initial = money(
          saved ? rowOf(saved).initial_usd : String(startUsd),
          'initial_capital',
        )
        if (display(initial) <= 0)
          throw new Error('account_invalid_initial_capital')
        const rows = db
          .prepare(
            `SELECT * FROM trades ORDER BY (status='open') ASC, exit_ms ASC, trade_no ASC`,
          )
          .all()
          .map((row) => rowOf(row))
        const steps: QwenAccountStep[] = []
        let balance = initial
        let realized = '0'
        let openUsd = '0'
        let openCount = 0
        let incomplete = false
        for (const row of rows) {
          const side =
            row.side === 'LONG' || row.side === 'SHORT' ? row.side : null
          const tradeNo = num(row.trade_no)
          if (side === null || tradeNo === null)
            throw new Error('account_invalid_trade')
          if (row.funding_status !== 'complete') incomplete = true
          if (row.status === 'open') {
            openUsd = sum(openUsd, money(row.net_now_usd, 'open_result'))
            openCount += 1
            continue
          }
          if (row.status !== 'closed')
            throw new Error('account_invalid_trade_status')
          const net = money(row.net_usd, 'realized_result')
          const exit = num(row.exit_ms)
          if (exit === null) throw new Error('account_invalid_exit_time')
          realized = sum(realized, net)
          balance = sum(balance, net)
          steps.push({
            product: String(row.product),
            trade_no: tradeNo,
            side,
            exit_ms: exit,
            net_usd: display(net),
            balance_usd: display(balance),
          })
        }
        return {
          status: 'ok' as const,
          start_usd: display(initial),
          balance_usd: display(sum(balance, openUsd)),
          realized_usd: display(realized),
          open_usd: display(openUsd),
          open_count: openCount,
          funding_incomplete: incomplete,
          steps,
        }
      })
      if (opened.state !== 'read')
        return {
          status: opened.state === 'missing' ? 'off' : 'error',
          reason: opened.detail,
        }
      return opened.value
    },
  }
}
