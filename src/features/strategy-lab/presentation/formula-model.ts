import { useMemo, useState } from 'react'
import type { QuickFormula } from '../infrastructure/quick-api.ts'
import type { RunCandle, RunTrade } from '../infrastructure/run-visual-api.ts'

const HOUR_MS = 3_600_000

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
}

/**
 * What the panel of a run draws (verdict, the single market chart with every operation, zoom on a tap) for the
 * test of the formula alone, which has no run of its own: its operations and the hourly prices come in the saved
 * result. `null` while there is nothing to draw.
 */
export function useFormulaModel(
  formula: QuickFormula | null,
): FormulaModel | null {
  const product =
    formula?.productos[0] ?? Object.keys(formula?.mercado ?? {})[0]
  const points = useMemo(
    () => (product ? (formula?.mercado?.[product] ?? []) : []),
    [formula, product],
  )
  const trades = useMemo<RunTrade[]>(
    () =>
      !formula || points.length < 2 || !product
        ? []
        : (formula.curvas.formula ?? [])
            .filter((trade) => trade.producto === product)
            .map((trade, index) => ({
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
              pnl_usd: (trade.neto_bp / 1e4) * formula.nocional_usd,
              funding_usd: null,
              funding_status: 'unknown',
              notional_usd: String(formula.nocional_usd),
              signal_time_ms: null,
            })),
    [formula, points, product],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = trades.find((trade) => trade.trade_id === selectedId) ?? null
  const all = useMemo(() => candlesOf(points), [points])
  const candles = useMemo(() => {
    if (!selected) return all
    const held = selected.exit_time_ms - selected.entry_time_ms
    const pad = Math.max(held * 0.5, 6 * HOUR_MS)
    const cut = all.filter(
      (c) =>
        c.time_ms >= selected.entry_time_ms - pad &&
        c.time_ms <= selected.exit_time_ms + pad,
    )
    return cut.length >= 2 ? cut : all
  }, [all, selected])
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
  }
}
