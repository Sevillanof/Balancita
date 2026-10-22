import type {
  AnalyzerCell,
  AnalyzerEvent,
  AnalyzerEvents,
} from '../infrastructure/analyzer-api.ts'

/**
 * Qué parte del margen se puede perder antes de dar la operación por
 * liquidada. Es una APROXIMACIÓN conservadora: un exchange real liquida
 * cerca del 100 % del margen menos un colchón que depende del producto; acá
 * se toma la mitad y, al llegar, se cuenta perdido TODO el margen. Con
 * apalancamiento L, la mitad del margen se pierde cuando el precio va en
 * contra `10000 · 0,5 / L` pb (5000/L).
 */
export const LIQUIDATION_LOSS_SHARE = 0.5

export const LEVERAGES = [1, 2, 3, 5, 10, 20] as const
export const ENTRY_SIZES = [100, 250, 500, 1000, 2500, 5000] as const

export type SimTrade = {
  t: number
  /** Resultado final de la operación, en USD (con piso en −margen). */
  netUsd: number
  /** Antes de costes y funding, en USD: neto + costes + funding. */
  grossUsd: number
  liquidated: boolean
}

export type SimResult = {
  trades: SimTrade[]
  n: number
  netUsd: number
  /** Antes de costes y funding. */
  grossUsd: number
  /** Costes pagados (positivo). */
  costUsd: number
  /** Funding pagado (positivo) o cobrado (negativo). */
  fundingUsd: number
  /** % de operaciones con resultado neto > 0. */
  hitRate: number
  /** % de operaciones con bruto > 0 (la señal acertó la dirección, antes de costes). */
  directionRate: number
  liquidations: number
  /** Resultado acumulado, partiendo de 0 (largo n + 1). */
  equity: number[]
  /** Caída máxima desde un pico, positiva, en USD. */
  maxDrawdownUsd: number
  /** Caída máxima como % de la entrada por operación. */
  maxDrawdownPct: number
  worstUsd: number
}

export function eventsKey(cell: AnalyzerCell): string {
  return `${cell.product}|${cell.kind}|${cell.window}`
}

const finite = (value: number) => (Number.isFinite(value) ? value : 0)

/** Simula una combinación con apalancamiento `leverage` y `margin` USD por operación. */
export function simulate(
  cell: AnalyzerCell,
  leverage: number,
  margin: number,
  data: Pick<AnalyzerEvents, 'events' | 'round_trip_cost_bp'>,
): SimResult {
  const raw: AnalyzerEvent[] = data.events[eventsKey(cell)] ?? []
  const events = [...raw].sort((a, b) => a.t - b.t)
  const costBp = finite(data.round_trip_cost_bp[cell.product] ?? 0)
  const notional = margin * leverage
  const limitBp = (10000 * LIQUIDATION_LOSS_SHARE) / leverage
  const trades: SimTrade[] = []
  const equity = [0]
  let net = 0
  let cost = 0
  let funding = 0
  let wins = 0
  let right = 0
  let liquidations = 0
  let peak = 0
  let drawdown = 0
  let worst = 0

  for (const event of events) {
    const stats = event.h[String(cell.horizon)]
    if (!stats) continue
    const d = cell.direction === 'follow' ? event.s : -event.s
    const grossBp = d * finite(stats.r)
    const adverseBp = d > 0 ? -finite(stats.dn) : finite(stats.up)
    const fundingBp = d > 0 ? finite(stats.f) : -finite(stats.f)
    const costUsd = (notional * costBp) / 10000
    const fundingUsd = (notional * fundingBp) / 10000
    const liquidated = adverseBp >= limitBp
    const unfloored = (notional * (grossBp - costBp - fundingBp)) / 10000
    const netUsd = liquidated ? -margin : Math.max(unfloored, -margin)
    trades.push({
      t: event.t,
      netUsd,
      grossUsd: netUsd + costUsd + fundingUsd,
      liquidated,
    })
    net += netUsd
    cost += costUsd
    funding += fundingUsd
    if (netUsd > 0) wins += 1
    if (grossBp > 0) right += 1
    if (liquidated) liquidations += 1
    if (netUsd < worst) worst = netUsd
    equity.push(net)
    peak = Math.max(peak, net)
    drawdown = Math.max(drawdown, peak - net)
  }

  const n = trades.length
  return {
    trades,
    n,
    netUsd: net,
    grossUsd: net + cost + funding,
    costUsd: cost,
    fundingUsd: funding,
    hitRate: n ? (100 * wins) / n : 0,
    directionRate: n ? (100 * right) / n : 0,
    liquidations,
    equity,
    maxDrawdownUsd: drawdown,
    maxDrawdownPct: margin > 0 ? (100 * drawdown) / margin : 0,
    worstUsd: worst,
  }
}
