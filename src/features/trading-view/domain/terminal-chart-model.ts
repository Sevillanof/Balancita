import type {
  ApprovedChartPriceLine,
  ApprovedTerminalCandle,
  ApprovedTerminalMarker,
} from '../presentation/ApprovedTerminalChart.tsx'
import { aggregate } from './chart-indicators.ts'

const EXIT_LABELS: Record<string, string> = {
  protective_stop: 'STOP',
  profit_target: 'OBJETIVO',
  time_stop: 'TIEMPO',
  daily_loss_limit: 'LÍMITE',
}

const STRATEGY_COLORS: Record<string, string> = {
  c25: '#4fa3e0',
  c26: '#c78be0',
  c27: '#e0a04f',
  c28: '#5fd0c0',
}

/** Short code of a strategy id: `c25-pullback-perp-v1` -> `C25`. */
export function strategyCode(id: string | undefined | null): string | null {
  const match = /^(c\d+)-/.exec(id ?? '')
  return match ? match[1]!.toUpperCase() : null
}

/** Fixed colour per strategy, so its markers read the same everywhere. */
export function strategyMarkerColor(
  id: string | undefined | null,
): string | undefined {
  const code = strategyCode(id)
  return code ? STRATEGY_COLORS[code.toLowerCase()] : undefined
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Filled reduce-only orders of paper execution D, as exit markers. */
export function exitMarkers(
  orders: readonly unknown[],
): ApprovedTerminalMarker[] {
  return orders.flatMap((value) => {
    const order = recordOf(value)
    const at = Number(order.closed_at_ms)
    if (
      order.state !== 'filled' ||
      order.reduce_only !== true ||
      typeof order.order_id !== 'string' ||
      !Number.isSafeInteger(at)
    )
      return []
    const strategyId =
      typeof order.strategy_id === 'string' ? order.strategy_id : undefined
    const code = strategyCode(strategyId)
    const label = EXIT_LABELS[String(order.reason_code)] ?? 'SALIDA'
    return [
      {
        id: `exit:${order.order_id}`,
        time: Math.floor(at / 1000),
        type: 'exit' as const,
        label: code ? `${code} ${label}` : label,
        ...(strategyId ? { strategyId } : {}),
      },
    ]
  })
}

/** Entry, stop and target of the open paper position as price lines. */
export function positionLines(
  position: Record<string, unknown>,
  colors: { entry: string; stop: string; target: string },
): ApprovedChartPriceLine[] {
  if (position.side !== 'long' && position.side !== 'short') return []
  const lines: ApprovedChartPriceLine[] = []
  const add = (
    id: string,
    value: unknown,
    title: string,
    color: string,
    dashed: boolean,
  ) => {
    const price = Number(value)
    if (value != null && Number.isFinite(price) && price > 0)
      lines.push({ id, price, title, color, dashed })
  }
  add(
    'entry',
    position.entry_price_usd_per_btc,
    position.side === 'long' ? 'ENTRADA LARGO' : 'ENTRADA CORTO',
    colors.entry,
    false,
  )
  add('stop', position.stop, 'STOP', colors.stop, true)
  add('target', position.target, 'OBJETIVO', colors.target, true)
  return lines
}

/**
 * Candles of the chosen timeframe: the server series (official candles plus
 * provisional ones) with its last bucket kept current by the live 1m stream;
 * without a server series, the 1m stream folded locally.
 */
export function timeframeCandles(
  minute: readonly ApprovedTerminalCandle[],
  intervalSeconds: number,
  remote: readonly ApprovedTerminalCandle[] | null,
): ApprovedTerminalCandle[] {
  if (intervalSeconds === 60) return [...minute]
  if (!remote || remote.length === 0) return aggregate(minute, intervalSeconds)
  const out = remote.map((candle) => ({ ...candle }))
  const last = out.at(-1)!
  for (const candle of aggregate(
    minute.filter((item) => item.time >= last.time),
    intervalSeconds,
  )) {
    const tail = out.at(-1)!
    if (candle.time === tail.time) {
      tail.high = Math.max(tail.high, candle.high)
      tail.low = Math.min(tail.low, candle.low)
      tail.close = candle.close
    } else if (candle.time > tail.time) out.push(candle)
  }
  return out
}
