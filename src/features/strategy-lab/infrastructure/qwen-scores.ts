import type { BacktestTrade } from './strategy-api.ts'

/**
 * Qwen's decision scores from the live gateway (`docs/qwen-scores-api.md`):
 * every decision +1 hit / -1 miss after its horizon, plus the same paper book
 * and costs as the strategy backtest.
 */
export const QWEN_SCORES_URL = '/api-live/qwen/scores'
/** Kronos' forward paper decisions, served in the same shape. */
export const KRONOS_SCORES_URL = '/api-live/kronos/scores'

export type QwenOption = 'buy' | 'hold' | 'sell'

export type QwenDecisionStats = {
  decisions: number
  scored: number
  pending: number
  hits: number
  misses: number
  points: number
  hit_rate: number | null
  mean_net_bp: number | null
  total_net_bp: number | null
}

export type QwenRow = {
  bucket_start: number
  chosen: QwenOption
  confidence: number | null
  status: 'scored' | 'pending'
  point: 1 | -1 | null
  net_bp: number | null
}

export type QwenProduct = {
  product_id: string
  horizon_min: number
  decisions: QwenDecisionStats
  by_option: Partial<Record<QwenOption, QwenDecisionStats>>
  /** Hit rate of answering `hold` every time on the same scored decisions. */
  baseline?: { always_hold_rate: number | null; scored: number }
  trading: {
    trades: number
    wins: number
    hit_rate: number | null
    pnl_usd: number
    return_pct: number
    max_drawdown: { pct: number | null; at_ms: number | null }
  }
  rows: QwenRow[]
  trades: BacktestTrade[]
  /** Position still open in Qwen's paper book, valued net of costs at the last close. */
  open_position?: QwenOpenPosition | null
}

export type QwenOpenPosition = {
  side: 'LONG' | 'SHORT'
  entry_time_ms: number
  /** Null when the fill is not known yet (Kronos stores it on close). */
  entry_price: string | null
  mark_price: string | null
  net_bp: number | null
  pnl_usd: number | null
}

export type QwenScores = {
  status: 'ok' | 'off' | 'error'
  reason?: string
  generated_at?: number
  products: QwenProduct[]
}

export function loadQwenScores(
  fetcher: typeof fetch = (...args) => fetch(...args),
  product = 'PF_XBTUSD',
): Promise<QwenScores> {
  return loadScores(QWEN_SCORES_URL, fetcher, product)
}

export function loadKronosScores(
  fetcher: typeof fetch = (...args) => fetch(...args),
  product = 'PF_XBTUSD',
): Promise<QwenScores> {
  return loadScores(KRONOS_SCORES_URL, fetcher, product)
}

async function loadScores(
  url: string,
  fetcher: typeof fetch,
  product: string,
): Promise<QwenScores> {
  try {
    const response = await fetcher(
      `${url}?product=${encodeURIComponent(product)}`,
    )
    const body = (await response.json()) as Partial<QwenScores>
    if (!response.ok && body.status === undefined)
      return { status: 'off', reason: `HTTP ${response.status}`, products: [] }
    return {
      status: body.status ?? 'error',
      reason: body.reason,
      generated_at: body.generated_at,
      products: Array.isArray(body.products) ? body.products : [],
    }
  } catch {
    return { status: 'off', reason: 'gateway_unreachable', products: [] }
  }
}
