import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/**
 * Read-only list of every paper movement of the two models, for the
 * "Movimientos" screen (`docs/movimientos-api.md`).
 *
 * Where each one really lives (neither goes through process D):
 *  - Qwen: C31 (`futures_qwen_exit.py`) opens positions from the shipped specs
 *    and Qwen decides every close. Own DB `qwen-exit.sqlite`
 *    (`qwen_exit_trade`, `qwen_exit_open`, `qwen_exit_decision`).
 *  - Kronos: `kronos_lab` opens a position when its 4 h forecast clears twice
 *    the round-trip cost. Own DB `kronos.sqlite` (`decision`, `trade`).
 *
 * Both DBs are opened read-only; this module never writes. Fees are derived
 * for display from the frozen taker rate (the books store only the net).
 */
export type MovementSource = 'qwen' | 'kronos'
export type MovementStatus = 'open' | 'closed'
type Side = 'LONG' | 'SHORT'

export interface Movement {
  readonly id: string
  readonly source: MovementSource
  readonly product_id: string
  readonly side: Side
  readonly status: MovementStatus
  readonly opened_at_ms: number
  readonly closed_at_ms: number | null
  /** Null when the book stores the fill only at close (open positions). */
  readonly entry_price: string | null
  readonly exit_price: string | null
  readonly quantity: string | null
  readonly notional_usd: number
  readonly fees_usd: number | null
  readonly funding_usd: number | null
  readonly funding_status: 'complete' | 'partial' | 'unknown' | 'not_charged'
  /** Net of fees and funding (open: valued at the last close). */
  readonly net_usd: number | null
  readonly net_pct: number | null
  /** Why it opened (Qwen: the strategy that proposed it; Kronos: the forecast). */
  readonly open_reason: string | null
  /** Why it closed (null while open). */
  readonly close_reason: string | null
  /** Qwen: last decision seen; Kronos: its forecast. */
  readonly decision: {
    readonly answer: string | null
    readonly probability: number | null
    readonly at_ms: number | null
  } | null
  readonly forecast: {
    readonly expected_bp: number
    readonly threshold_bp: number
  } | null
}

export interface SourceSummary {
  readonly operations: number
  readonly open: number
  readonly closed: number
  readonly wins: number
  readonly hit_rate: number | null
  readonly net_usd: number
  /** Kronos only: hourly forecasts that did not trade. */
  readonly forecasts_without_trade: number | null
}

export interface MovementsQuery {
  readonly source?: string
  readonly product?: string
  readonly from?: string
  readonly to?: string
  readonly status?: string
  readonly limit?: string
  readonly offset?: string
}

export type MovementsResponse =
  | {
      readonly status: 'ok'
      readonly generated_at: number
      readonly source: MovementSource
      readonly summary: Record<MovementSource, SourceSummary>
      readonly page: {
        readonly limit: number
        readonly offset: number
        readonly total: number
      }
      readonly items: readonly Movement[]
      readonly sources: Record<MovementSource, 'ok' | 'off'>
      readonly reasons: Record<MovementSource, string | null>
    }
  | { readonly status: 'error'; readonly reason: string }

export interface Movements {
  report(query: MovementsQuery): MovementsResponse
}

export interface MovementsOptions {
  readonly qwenExitDbPath?: string
  readonly kronosDbPath?: string
  readonly cacheMs?: number
  readonly clock?: () => number
}

const PRODUCT = /^PF_[A-Z0-9]{2,16}$/
const TAKER_RATE = 0.0005
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const KRONOS_NOTIONAL = 100
/** Same per-trade size as `config/qwen-exit.json`, used for open positions. */
const QWEN_NOTIONAL = 100
const SOURCES: readonly MovementSource[] = ['qwen', 'kronos']

const round = (value: number, digits = 4) => {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function parse(text: unknown): Record<string, unknown> | null {
  try {
    const value = JSON.parse(String(text)) as unknown
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const side = (v: unknown): Side | null =>
  v === 'LONG' || v === 'SHORT' ? v : null

function netPct(netUsd: number | null, notional: number) {
  return netUsd === null ? null : round((netUsd / notional) * 100, 4)
}

function fees(entry: unknown, exit: unknown, qty: unknown) {
  const e = Number(entry)
  const x = Number(exit)
  const q = Number(qty)
  return [e, x, q].every(Number.isFinite)
    ? round((e + x) * q * TAKER_RATE, 4)
    : null
}

function openDb(path: string | undefined): DatabaseSync | null {
  if (!path || !existsSync(path)) return null
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

interface Loaded {
  readonly items: Movement[]
  readonly status: 'ok' | 'off'
  readonly reason: string | null
  readonly forecastsWithoutTrade: number | null
}

function loadQwen(path: string | undefined): Loaded {
  const db = openDb(path)
  if (!db)
    return {
      items: [],
      status: 'off',
      reason: 'qwen_db_missing',
      forecastsWithoutTrade: null,
    }
  try {
    const items: Movement[] = []
    const decisions = new Map<string, Record<string, unknown>[]>()
    for (const row of db
      .prepare(
        'SELECT product_id, payload FROM qwen_exit_decision ORDER BY bucket_ms',
      )
      .all() as Record<string, unknown>[]) {
      const payload = parse(row.payload)
      if (!payload) continue
      const key = String(row.product_id)
      decisions.set(key, [...(decisions.get(key) ?? []), payload])
    }
    const decisionOf = (
      product: string,
      pick: (d: Record<string, unknown>) => boolean,
      last: boolean,
    ) => {
      const list = (decisions.get(product) ?? []).filter(pick)
      const d = last ? list.at(-1) : list[0]
      if (!d) return null
      const probabilities = d.probabilities as
        Record<string, unknown> | undefined
      const answer = typeof d.chosen === 'string' ? d.chosen : null
      return {
        answer,
        probability: answer ? num(probabilities?.[answer]) : null,
        at_ms: num(d.bucket_start),
      }
    }
    for (const row of db
      .prepare('SELECT product_id, payload FROM qwen_exit_trade')
      .all() as Record<string, unknown>[]) {
      const t = parse(row.payload)
      const s = side(t?.side)
      if (!t || !s) continue
      const product = String(row.product_id)
      const notional = Number(t.notional_usd) || QWEN_NOTIONAL
      const net = num(t.pnl_usd)
      const exitBucket = num(t.exit_bucket_ms)
      const funding = num(t.funding_usd)
      const status = t.funding_status
      items.push({
        id: `qwen:${product}:${String(t.entry_bucket_ms)}`,
        source: 'qwen',
        product_id: product,
        side: s,
        status: 'closed',
        opened_at_ms: Number(t.entry_time_ms),
        closed_at_ms: num(t.exit_time_ms),
        entry_price: String(t.entry_price),
        exit_price: String(t.exit_price),
        quantity: t.quantity === undefined ? null : String(t.quantity),
        notional_usd: notional,
        fees_usd: fees(t.entry_price, t.exit_price, t.quantity),
        funding_usd: funding,
        funding_status:
          status === 'complete' || status === 'partial' ? status : 'unknown',
        net_usd: net,
        net_pct: netPct(net, notional),
        open_reason: typeof t.reason_code === 'string' ? t.reason_code : null,
        close_reason: typeof t.exit_reason === 'string' ? t.exit_reason : null,
        decision:
          exitBucket === null
            ? null
            : decisionOf(product, (d) => d.bucket_start === exitBucket, true),
        forecast: null,
      })
    }
    for (const row of db
      .prepare('SELECT product_id, payload FROM qwen_exit_open')
      .all() as Record<string, unknown>[]) {
      const o = parse(row.payload)
      const s = side(o?.side)
      const opened = num(o?.entry_bucket_ms)
      if (!o || !s || opened === null) continue
      const product = String(row.product_id)
      const bp = num(o.net_bp)
      const net = bp === null ? null : round((bp / 10_000) * QWEN_NOTIONAL)
      items.push({
        id: `qwen:${product}:${String(opened)}`,
        source: 'qwen',
        product_id: product,
        side: s,
        status: 'open',
        opened_at_ms: opened,
        closed_at_ms: null,
        entry_price: null,
        exit_price: null,
        quantity: null,
        notional_usd: QWEN_NOTIONAL,
        fees_usd: null,
        funding_usd: null,
        funding_status: 'unknown',
        net_usd: net,
        net_pct: netPct(net, QWEN_NOTIONAL),
        open_reason: null,
        close_reason: null,
        decision: decisionOf(product, () => true, true),
        forecast: null,
      })
    }
    return { items, status: 'ok', reason: null, forecastsWithoutTrade: null }
  } catch (error) {
    return {
      items: [],
      status: 'off',
      reason: `qwen_read_failed: ${String(error)}`,
      forecastsWithoutTrade: null,
    }
  } finally {
    db.close()
  }
}

function loadKronos(path: string | undefined): Loaded {
  const db = openDb(path)
  if (!db)
    return {
      items: [],
      status: 'off',
      reason: 'kronos_db_missing',
      forecastsWithoutTrade: null,
    }
  try {
    const rows = db
      .prepare(
        `SELECT d.product_id, d.decision_ms, d.side, d.expected_bp, d.threshold_bp, t.payload
           FROM decision d
           LEFT JOIN trade t
             ON t.product_id = d.product_id AND t.decision_ms = d.decision_ms AND t.mode = 'forward'
          WHERE d.mode = 'forward'
          ORDER BY d.decision_ms`,
      )
      .all() as Record<string, unknown>[]
    const items: Movement[] = []
    let without = 0
    for (const row of rows) {
      const s = side(row.side)
      if (!s) {
        without += 1
        continue
      }
      const product = String(row.product_id)
      const decisionMs = Number(row.decision_ms)
      const forecast = {
        expected_bp: round(Number(row.expected_bp), 2),
        threshold_bp: round(Number(row.threshold_bp), 2),
      }
      const t = row.payload == null ? null : parse(row.payload)
      const net = num(t?.pnl_usd)
      const closed = t !== null && net !== null
      items.push({
        id: `kronos:${product}:${decisionMs}`,
        source: 'kronos',
        product_id: product,
        side: s,
        status: closed ? 'closed' : 'open',
        opened_at_ms: closed ? Number(t.entry_time_ms) : decisionMs,
        closed_at_ms: closed ? num(t.exit_time_ms) : null,
        entry_price: closed ? String(t.entry) : null,
        exit_price: closed ? String(t.exit) : null,
        quantity: closed
          ? String(round(KRONOS_NOTIONAL / Number(t.entry), 8))
          : null,
        notional_usd: KRONOS_NOTIONAL,
        // Two taker fees on the 100 USD, exactly as the lab nets them.
        fees_usd: closed ? round(KRONOS_NOTIONAL * TAKER_RATE * 2) : null,
        funding_usd: null,
        funding_status: 'not_charged',
        net_usd: net,
        net_pct: netPct(net, KRONOS_NOTIONAL),
        open_reason: 'forecast',
        close_reason: closed ? 'time_stop' : null,
        decision: null,
        forecast,
      })
    }
    return { items, status: 'ok', reason: null, forecastsWithoutTrade: without }
  } catch (error) {
    return {
      items: [],
      status: 'off',
      reason: `kronos_read_failed: ${String(error)}`,
      forecastsWithoutTrade: null,
    }
  } finally {
    db.close()
  }
}

function summarize(items: readonly Movement[], without: number | null) {
  const closed = items.filter((m) => m.status === 'closed')
  const wins = closed.filter((m) => (m.net_usd ?? 0) > 0).length
  return {
    operations: items.length,
    open: items.length - closed.length,
    closed: closed.length,
    wins,
    hit_rate: closed.length ? round(wins / closed.length) : null,
    net_usd: round(
      items.reduce((sum, m) => sum + (m.net_usd ?? 0), 0),
      2,
    ),
    forecasts_without_trade: without,
  }
}

/** `1791000000000` or an ISO date; anything else is invalid. */
function parseTime(
  value: string | undefined,
  endOfDay: boolean,
): number | null | 'bad' {
  if (value === undefined || value === '') return null
  if (/^\d{10,16}$/.test(value)) return Number(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`)
    return Number.isNaN(ms) ? 'bad' : ms + (endOfDay ? 86_400_000 - 1 : 0)
  }
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? 'bad' : ms
}

function intParam(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === '') return fallback
  if (!/^\d{1,9}$/.test(value)) return null
  const n = Number(value)
  return n < min || n > max ? null : n
}

export function createMovements(options: MovementsOptions): Movements {
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? 5_000
  let cache: { at: number; loaded: Record<MovementSource, Loaded> } | null =
    null
  const load = () => {
    if (cache && clock() - cache.at < cacheMs) return cache.loaded
    const loaded = {
      qwen: loadQwen(options.qwenExitDbPath),
      kronos: loadKronos(options.kronosDbPath),
    }
    cache = { at: clock(), loaded }
    return loaded
  }

  return {
    report(query) {
      const source = query.source ?? 'qwen'
      if (source !== 'qwen' && source !== 'kronos')
        return { status: 'error', reason: 'invalid_source' }
      if (query.product && !PRODUCT.test(query.product))
        return { status: 'error', reason: 'invalid_product' }
      if (query.status && query.status !== 'open' && query.status !== 'closed')
        return { status: 'error', reason: 'invalid_status' }
      const from = parseTime(query.from, false)
      const to = parseTime(query.to, true)
      if (from === 'bad' || to === 'bad')
        return { status: 'error', reason: 'invalid_range' }
      const limit = intParam(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
      const offset = intParam(query.offset, 0, 0, 1_000_000)
      if (limit === null) return { status: 'error', reason: 'invalid_limit' }
      if (offset === null) return { status: 'error', reason: 'invalid_offset' }

      const loaded = load()
      // Product and date filters shape both summaries; status only the table.
      const inScope = (m: Movement) =>
        (!query.product || m.product_id === query.product) &&
        (from === null || m.opened_at_ms >= from) &&
        (to === null || m.opened_at_ms <= to)
      const scoped = {} as Record<MovementSource, Movement[]>
      const summary = {} as Record<MovementSource, SourceSummary>
      for (const name of SOURCES) {
        scoped[name] = loaded[name].items.filter(inScope)
        summary[name] = summarize(
          scoped[name],
          loaded[name].forecastsWithoutTrade,
        )
      }
      const rows = scoped[source]
        .filter((m) => !query.status || m.status === query.status)
        .sort(
          (a, b) => b.opened_at_ms - a.opened_at_ms || (a.id < b.id ? -1 : 1),
        )
      return {
        status: 'ok',
        generated_at: clock(),
        source,
        summary,
        page: { limit, offset, total: rows.length },
        items: rows.slice(offset, offset + limit),
        sources: { qwen: loaded.qwen.status, kronos: loaded.kronos.status },
        reasons: { qwen: loaded.qwen.reason, kronos: loaded.kronos.reason },
      }
    },
  }
}
