import { useMemo, useState } from 'react'
import { ROUND_TRIP_COST_BP } from '../domain/trade-potential.ts'
import type { Cuenta, QuickFormula } from '../infrastructure/quick-api.ts'
import type { RunCandle, RunTrade } from '../infrastructure/run-visual-api.ts'

const HOUR_MS = 3_600_000
/** The account the whole-account size starts from, in USD. */
export const ACCOUNT_USD = 1000

/** The hourly closes the formula test saved, as the candles the market chart draws. */
function candlesOf(points: Array<[number, number]>): RunCandle[] {
  return points.map(([time_ms, close]) => ({
    time_ms,
    open: String(close),
    high: String(close),
    low: String(close),
    close: String(close),
    volume: '0',
  }))
}

/** The price the market had at `ms`: the nearest saved close. */
function priceAt(points: Array<[number, number]>, ms: number): number {
  let best = points[0]!
  for (const point of points)
    if (Math.abs(point[0] - ms) < Math.abs(best[0] - ms)) best = point
  return best[1]
}

/** The period the chart draws: the saved prices can run a little past the last look, and the texts say the same dates. */
export function periodOf(formula: QuickFormula): {
  fromMs: number
  toMs: number
} {
  let fromMs = formula.desde_ms
  let toMs = formula.hasta_ms
  for (const points of Object.values(formula.mercado ?? {})) {
    if (points.length === 0) continue
    fromMs = Math.min(fromMs, points[0]![0])
    toMs = Math.max(toMs, points[points.length - 1]![0])
  }
  return { fromMs, toMs }
}

export type FormulaModel = {
  product: string
  /** Hourly closes of the whole period, oldest first. */
  closes: number[]
  trades: RunTrade[]
  /** The candles on screen: the whole period, or the window around the chosen operation. */
  candles: RunCandle[]
  selected: RunTrade | null
  select: (trade: RunTrade) => void
  showAll: () => void
  figures: FormulaFigures
  /** The stretch the result covers. */
  fromMs: number
  toMs: number
  /** The account the trades started from when each one used the whole account; `null` with fixed sizes. */
  accountUsd: number | null
}

/**
 * What the panel of a run draws (verdict, the single market chart with every operation, zoom on a tap) for the
 * test of the formula alone, which has no run of its own: its operations and the hourly prices come in the saved
 * result. `null` while there is nothing to draw.
 */
export function useFormulaModel(
  formula: QuickFormula | null,
  cuenta: Cuenta = 'fija',
): FormulaModel | null {
  const product =
    formula?.productos[0] ?? Object.keys(formula?.mercado ?? {})[0]
  const points = useMemo(
    () => (product ? (formula?.mercado?.[product] ?? []) : []),
    [formula, product],
  )
  const trades = useMemo<RunTrade[]>(() => {
    if (!formula || points.length < 2 || !product) return []
    // With the whole account each operation is as big as the account when it opens: 1.000 USD plus what the ones before made
    let account = ACCOUNT_USD
    return (formula.curvas.formula ?? [])
      .filter((trade) => trade.producto === product)
      .map((trade, index) => {
        const nocional = cuenta === 'entera' ? account : formula.nocional_usd
        const pnl = (trade.neto_bp / 1e4) * nocional
        account += cuenta === 'entera' ? pnl : 0
        return {
          trade_id: `formula-${index}`,
          product_id: trade.producto,
          side: trade.lado === 1 ? ('LONG' as const) : ('SHORT' as const),
          entry_time_ms: trade.entrada_ms,
          entry_bucket_ms: null,
          entry_price: String(priceAt(points, trade.entrada_ms)),
          exit_time_ms: trade.salida_ms,
          exit_bucket_ms: null,
          exit_price: String(priceAt(points, trade.salida_ms)),
          exit_reason: trade.motivo,
          reason_code: null,
          net_bp: trade.neto_bp,
          pnl_usd: pnl,
          funding_usd: null,
          funding_status: 'unknown',
          notional_usd: String(nocional),
          signal_time_ms: null,
          size_mult: trade.tamano ?? null,
          with_movement: trade.movimiento ?? null,
          detail: trade.velas ?? null,
          drop: trade.caida
            ? {
                from_ms: trade.caida.desde_ms,
                to_ms: trade.caida.hasta_ms,
                pct: trade.caida.pct,
                btc_pct: trade.caida.btc_pct,
              }
            : null,
        }
      })
  }, [formula, points, product, cuenta])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = trades.find((trade) => trade.trade_id === selectedId) ?? null
  const all = useMemo(() => candlesOf(points), [points])
  const candles = useMemo(() => {
    if (!selected) return all
    // The rebound entries bring the 5-minute prices around each operation: the zoom uses them instead of the hourly ones
    const detail = formula?.curvas.formula.find(
      (t) => t.entrada_ms === selected.entry_time_ms,
    )?.velas
    if (detail && detail.length >= 2) return candlesOf(detail)
    const held = selected.exit_time_ms - selected.entry_time_ms
    const pad = Math.max(held * 0.5, 6 * HOUR_MS)
    const cut = all.filter(
      (c) =>
        c.time_ms >= selected.entry_time_ms - pad &&
        c.time_ms <= selected.exit_time_ms + pad,
    )
    return cut.length >= 2 ? cut : all
  }, [all, selected, formula])
  const closes = useMemo(() => points.map(([, close]) => close), [points])
  if (!product || trades.length === 0) return null
  return {
    product,
    closes,
    trades,
    candles,
    selected,
    select: (trade) => setSelectedId(trade.trade_id),
    showAll: () => setSelectedId(null),
    figures: formulaFigures(trades, formula!.desde_ms, formula!.hasta_ms),
    ...periodOf(formula!),
    accountUsd: cuenta === 'entera' ? ACCOUNT_USD : null,
  }
}

export type FormulaFigures = {
  trades: number
  meanBp: number
  positivePeriods: number
  periods: number
  /** Share of 1.000 draws (sides flipped by day) that did worse than the real result, 0-100. */
  percentile: number
}

const PERIODS = 5
const DRAWS = 1000
const DAY_MS = 86_400_000

/** The four figures of the panel, computed from the operations the result carries (no run summary exists for it). */
export function formulaFigures(
  trades: RunTrade[],
  fromMs: number,
  toMs: number,
): FormulaFigures {
  const n = trades.length
  const mean = trades.reduce((sum, t) => sum + t.net_bp, 0) / Math.max(n, 1)
  const span = Math.max(toMs - fromMs, 1)
  const sums = new Array<number>(PERIODS).fill(0)
  const counts = new Array<number>(PERIODS).fill(0)
  for (const trade of trades) {
    const k = Math.min(
      PERIODS - 1,
      Math.max(
        0,
        Math.floor(((trade.entry_time_ms - fromMs) / span) * PERIODS),
      ),
    )
    sums[k]! += trade.net_bp
    counts[k]! += 1
  }
  const used = counts.filter((c) => c > 0).length
  const positive = sums.filter((sum, k) => counts[k]! > 0 && sum > 0).length
  // Random control: one coin per day flips all the sides of that day. A flipped operation nets -net - 2 costs.
  let seed = 12345
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const days = [
    ...new Set(trades.map((t) => Math.floor(t.entry_time_ms / DAY_MS))),
  ]
  let below = 0
  for (let d = 0; d < DRAWS; d++) {
    const flip = new Map(days.map((day) => [day, rnd() < 0.5]))
    const total = trades.reduce(
      (sum, t) =>
        sum +
        (flip.get(Math.floor(t.entry_time_ms / DAY_MS))
          ? -t.net_bp - 2 * ROUND_TRIP_COST_BP
          : t.net_bp),
      0,
    )
    if (total / Math.max(n, 1) < mean) below += 1
  }
  return {
    trades: n,
    meanBp: mean,
    positivePeriods: positive,
    periods: used,
    percentile: (100 * below) / DRAWS,
  }
}
