import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { QwenScores, QwenScoresResponse } from './qwen-scores.ts'

/**
 * Kronos' forward paper decisions for the gateway, in the same shape as
 * Qwen's scores (`docs/qwen-scores-api.md`) so the Estrategias page shows both
 * alike. Read-only over `python/kronos_lab`'s `kronos.sqlite`; backtest rows
 * are left out. A report is reused for `cacheMs`.
 */
export interface KronosScoresOptions {
  readonly dbPath: string
  readonly cacheMs?: number
  readonly clock?: () => number
}

/** Kronos-small on 1 h candles, judged 4 h later, 100 USD per trade. */
const HORIZON_MIN = 240
const HORIZON_MS = HORIZON_MIN * 60_000
const INITIAL_CASH_USD = 100
const PRODUCT = /^PF_[A-Z0-9]{2,16}$/

type Side = 'LONG' | 'SHORT'

export interface KronosStats {
  readonly decisions: number
  readonly scored: number
  readonly pending: number
  readonly hits: number
  readonly misses: number
  readonly points: number
  readonly hit_rate: number | null
  readonly mean_net_bp: number | null
  readonly total_net_bp: number
}

export interface KronosTrade {
  readonly side: Side
  readonly entry_time_ms: number
  readonly entry_price: string
  readonly exit_time_ms: number
  readonly exit_price: string
  readonly exit_reason: 'time_stop'
  readonly net_bp: number
  readonly pnl_usd: number
}

export interface KronosProduct {
  readonly product_id: string
  readonly horizon_min: number
  readonly decisions: KronosStats
  readonly by_option: Record<'buy' | 'hold' | 'sell', KronosStats>
  readonly trading: {
    readonly trades: number
    readonly wins: number
    readonly hit_rate: number | null
    readonly pnl_usd: number
    readonly return_pct: number
    readonly max_drawdown: { pct: number | null; at_ms: number | null }
  }
  readonly rows: readonly never[]
  readonly trades: readonly KronosTrade[]
  readonly open_position: {
    readonly side: Side
    readonly entry_time_ms: number
    /** Kronos stores the fill only when the trade closes. */
    readonly entry_price: null
    readonly mark_price: null
    readonly net_bp: null
    readonly pnl_usd: null
  } | null
}

interface Decision {
  readonly product_id: string
  readonly decision_ms: number
  readonly side: Side | null
  readonly trade: KronosTrade | null
}

/** Four decimals, like the Python reports. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function parseTrade(payload: unknown): KronosTrade | null {
  try {
    const row = JSON.parse(String(payload)) as Record<string, unknown>
    if (
      (row.side !== 'LONG' && row.side !== 'SHORT') ||
      typeof row.entry_time_ms !== 'number' ||
      typeof row.exit_time_ms !== 'number' ||
      typeof row.net_bp !== 'number' ||
      typeof row.pnl_usd !== 'number'
    )
      return null
    return {
      side: row.side,
      entry_time_ms: row.entry_time_ms,
      entry_price: String(row.entry),
      exit_time_ms: row.exit_time_ms,
      exit_price: String(row.exit),
      exit_reason: 'time_stop',
      net_bp: row.net_bp,
      pnl_usd: row.pnl_usd,
    }
  } catch {
    return null
  }
}

/** Qwen's per-answer stats: a closed trade scores +1 when it netted > 0 bp. */
function stats(decisions: readonly Decision[]): KronosStats {
  const closed = decisions.flatMap((d) => (d.trade ? [d.trade] : []))
  const hits = closed.filter((trade) => trade.net_bp > 0).length
  const nets = closed.map((trade) => trade.net_bp)
  const total = nets.reduce((sum, net) => sum + net, 0)
  return {
    decisions: decisions.length,
    scored: closed.length,
    pending: decisions.filter((d) => d.side !== null && !d.trade).length,
    hits,
    misses: closed.length - hits,
    points: hits - (closed.length - hits),
    hit_rate: closed.length ? round(hits / closed.length) : null,
    mean_net_bp: nets.length ? round(total / nets.length) : null,
    total_net_bp: round(total),
  }
}

/** Worst fall of the running equity from its peak, as the Python backtest does. */
function maxDrawdown(trades: readonly KronosTrade[]) {
  let equity = INITIAL_CASH_USD
  let peak = INITIAL_CASH_USD
  let worst = 0
  let at: number | null = null
  for (const trade of trades) {
    equity += trade.pnl_usd
    peak = Math.max(peak, equity)
    const drawdown = ((equity - peak) / peak) * 100
    if (drawdown < worst) {
      worst = drawdown
      at = trade.exit_time_ms
    }
  }
  return { pct: round(worst), at_ms: at }
}

function productReport(
  productId: string,
  decisions: readonly Decision[],
  now: number,
): KronosProduct {
  const trades = decisions.flatMap((d) => (d.trade ? [d.trade] : []))
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl_usd, 0)
  const wins = trades.filter((trade) => trade.pnl_usd > 0).length
  const open = decisions.findLast((d) => d.side !== null)
  return {
    product_id: productId,
    horizon_min: HORIZON_MIN,
    decisions: stats(decisions),
    by_option: {
      buy: stats(decisions.filter((d) => d.side === 'LONG')),
      hold: stats(decisions.filter((d) => d.side === null)),
      sell: stats(decisions.filter((d) => d.side === 'SHORT')),
    },
    trading: {
      trades: trades.length,
      wins,
      hit_rate: trades.length ? round(wins / trades.length) : null,
      pnl_usd: round(pnl),
      return_pct: round((pnl / INITIAL_CASH_USD) * 100),
      max_drawdown: maxDrawdown(trades),
    },
    rows: [],
    trades,
    open_position:
      open?.side && !open.trade && open.decision_ms + HORIZON_MS > now
        ? {
            side: open.side,
            entry_time_ms: open.decision_ms,
            entry_price: null,
            mark_price: null,
            net_bp: null,
            pnl_usd: null,
          }
        : null,
  }
}

function readDecisions(dbPath: string, product: string): Decision[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db
      .prepare(
        `SELECT d.product_id, d.decision_ms, d.side, t.payload
           FROM decision d
           LEFT JOIN trade t
             ON t.product_id = d.product_id AND t.decision_ms = d.decision_ms AND t.mode = 'forward'
          WHERE d.mode = 'forward' AND (? = '' OR d.product_id = ?)
          ORDER BY d.product_id, d.decision_ms`,
      )
      .all(product, product) as Record<string, unknown>[]
    return rows.map((row) => ({
      product_id: String(row.product_id),
      decision_ms: Number(row.decision_ms),
      side: row.side === 'LONG' || row.side === 'SHORT' ? row.side : null,
      trade: row.payload == null ? null : parseTrade(row.payload),
    }))
  } finally {
    db.close()
  }
}

export function createKronosScores(options: KronosScoresOptions): QwenScores {
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? 15_000
  const cache = new Map<string, { at: number; value: QwenScoresResponse }>()

  const run = (product: string): QwenScoresResponse => {
    // Kronos runs outside pnpm dev: no DB yet is nothing to show, not a fault.
    if (!existsSync(options.dbPath))
      return { status: 'off', reason: 'kronos_db_missing' }
    let decisions: Decision[]
    try {
      decisions = readDecisions(options.dbPath, product)
    } catch (error) {
      return /unable to open database file/.test(String(error))
        ? { status: 'off', reason: 'kronos_db_missing' }
        : { status: 'error', reason: `read_failed: ${String(error)}` }
    }
    const now = clock()
    const byProduct = new Map<string, Decision[]>()
    for (const decision of decisions)
      byProduct.set(decision.product_id, [
        ...(byProduct.get(decision.product_id) ?? []),
        decision,
      ])
    return {
      status: 'ok',
      generated_at: now,
      products: [...byProduct].map(([id, rows]) =>
        productReport(id, rows, now),
      ),
    }
  }

  return {
    async report(product = '') {
      if (product && !PRODUCT.test(product))
        return { status: 'error', reason: 'invalid_product' }
      const cached = cache.get(product)
      if (cached && clock() - cached.at < cacheMs) return cached.value
      const value = run(product)
      cache.set(product, { at: clock(), value })
      return value
    },
  }
}
