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
  options: {
    /** Visible period in seconds: exits outside it are not drawn. */
    from?: number
    to?: number
    /** Names the source of the exits, e.g. «Histórico · Gateway D». */
    prefix?: string
  } = {},
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
    const time = Math.floor(at / 1000)
    if (
      (options.from !== undefined && time < options.from) ||
      (options.to !== undefined && time > options.to)
    )
      return []
    const strategyId =
      typeof order.strategy_id === 'string' ? order.strategy_id : undefined
    const code = strategyCode(strategyId)
    const label = EXIT_LABELS[String(order.reason_code)] ?? 'SALIDA'
    const text = code ? `${code} ${label}` : label
    return [
      {
        id: `exit:${order.order_id}`,
        time,
        type: 'exit' as const,
        label: options.prefix ? `${options.prefix} · ${text}` : text,
        ...(strategyId ? { strategyId } : {}),
      },
    ]
  })
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0')

/** `2026-10-14 12:34:56.789 UTC` from the fill's original event_time_ms. */
export function utcTime(ms: number): string {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)} UTC`
}

export interface FillDetailRow {
  key:
    'fill_id' | 'order_id' | 'time' | 'quantity' | 'side' | 'price' | 'source'
  label: string
  value: string
}

/**
 * Verifiable facts of ONE durable fill, exactly as the fill records them (no
 * decision or verdict is linked: they are independent events). A fact the
 * fill does not carry reads «No disponible».
 */
export function fillDetailRows(
  fill: unknown,
  options: { unit?: string; source?: string } = {},
): FillDetailRow[] {
  const data = recordOf(fill)
  const text = (value: unknown) =>
    typeof value === 'string' && value !== '' ? value : null
  const at = Number(data.event_time_ms)
  const quantity = text(data.quantity_btc)
  const price = text(data.price_usd_per_btc)
  const side =
    data.side === 'buy'
      ? 'LONG (compra)'
      : data.side === 'sell'
        ? 'SHORT (venta)'
        : null
  const none = 'No disponible'
  return [
    { key: 'fill_id', label: 'fill_id', value: text(data.fill_id) ?? none },
    { key: 'order_id', label: 'order_id', value: text(data.order_id) ?? none },
    {
      key: 'time',
      label: 'Hora',
      value: Number.isSafeInteger(at) ? utcTime(at) : none,
    },
    {
      key: 'quantity',
      label: 'Cantidad',
      value: quantity
        ? `${quantity}${options.unit ? ` ${options.unit}` : ''}`
        : none,
    },
    { key: 'side', label: 'Dirección', value: side ?? none },
    {
      key: 'price',
      label: 'Precio',
      value: price ? `${price} USD` : none,
    },
    { key: 'source', label: 'Procedencia', value: options.source ?? none },
  ]
}

/**
 * Operations actually executed, one marker per DURABLE FILL the gateway
 * delivers (`state.fills`, built from the engine's `order_filled` events), not
 * per order: a partial fill is its own marker with its own quantity. Each
 * keeps the fill's original id, order id, time and quantity. Reduce-only fills
 * are exits, not entries. No decision is linked to them (the record that would
 * link them is not here); `orders` only lends the strategy's code to the
 * label, through the fill's own `order_id`.
 */
export function fillMarkers(
  fills: readonly unknown[],
  orders: readonly unknown[] = [],
  options: {
    from?: number
    to?: number
    prefix?: string
    /** Unit of the quantity (the product's base), e.g. «BTC». */
    unit?: string
  } = {},
): ApprovedTerminalMarker[] {
  const strategyOf = new Map<string, string>()
  for (const value of orders) {
    const order = recordOf(value)
    if (
      typeof order.order_id === 'string' &&
      typeof order.strategy_id === 'string'
    )
      strategyOf.set(order.order_id, order.strategy_id)
  }
  return fills.flatMap((value) => {
    const fill = recordOf(value)
    const at = Number(fill.event_time_ms)
    const direction =
      fill.side === 'buy' ? 'long' : fill.side === 'sell' ? 'short' : null
    const amount = Number(fill.quantity_btc)
    if (
      fill.reduce_only === true ||
      direction === null ||
      typeof fill.fill_id !== 'string' ||
      typeof fill.order_id !== 'string' ||
      !Number.isSafeInteger(at) ||
      !(amount > 0)
    )
      return []
    const time = Math.floor(at / 1000)
    if (
      (options.from !== undefined && time < options.from) ||
      (options.to !== undefined && time > options.to)
    )
      return []
    const strategyId = strategyOf.get(fill.order_id)
    const code = strategyCode(strategyId)
    const quantity = `${String(fill.quantity_btc)}${options.unit ? ` ${options.unit}` : ''}`
    const text = `${code ? `${code} ` : ''}EJEC. ${direction === 'long' ? 'LONG' : 'SHORT'} ${quantity}`
    // On the chart only a short tag; the full text shows when selected.
    const shortText = `${code ? `${code} ` : ''}EJ ${direction === 'long' ? 'L' : 'S'}`
    return [
      {
        id: fill.fill_id,
        time,
        type: 'fill' as const,
        direction,
        label: options.prefix ? `${options.prefix} · ${shortText}` : shortText,
        detail: options.prefix ? `${options.prefix} · ${text}` : text,
        ...(strategyId ? { strategyId } : {}),
      },
    ]
  })
}

/**
 * WAIT verdicts come once a minute: one marker per `spanSeconds` window (the
 * newest of the window carries the id, all of them are members) so they do not
 * bury the proposals and fills. Other markers pass through untouched.
 */
export function groupWaitMarkers(
  markers: readonly ApprovedTerminalMarker[],
  spanSeconds: number,
): ApprovedTerminalMarker[] {
  const groups = new Map<number, ApprovedTerminalMarker[]>()
  const out: ApprovedTerminalMarker[] = []
  for (const marker of markers) {
    if (marker.type !== 'wait') {
      out.push(marker)
      continue
    }
    const key = Math.floor(marker.time / spanSeconds)
    groups.set(key, [...(groups.get(key) ?? []), marker])
  }
  for (const members of groups.values()) {
    const newest = members.reduce((a, b) => (b.time >= a.time ? b : a))
    out.push(
      members.length === 1
        ? newest
        : {
            ...newest,
            label: `W×${members.length}`,
            detail: `WAIT ×${members.length}`,
            count: members.length,
            memberIds: members.map((member) => member.id),
          },
    )
  }
  return out
}

/** Entry, stop and target of the open paper position as price lines. */
export function positionLines(
  position: Record<string, unknown>,
  colors: { entry: string; stop: string; target: string },
  /** Several books draw their own lines: ids stay apart, titles name the strategy. */
  book?: { id: string; code: string | null },
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
      lines.push({
        id: book ? `${book.id}:${id}` : id,
        price,
        title: book?.code ? `${book.code} ${title}` : title,
        color,
        dashed,
      })
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

/**
 * Open positions of the chart's product: the gateway list, else the single
 * position. Orders and fills carry no product id: they are isolated by the
 * gateway, whose follower serves one product per stream and drops the events
 * of other books (paper-engine-follower `ownsBook`, covered by its tests).
 * Position rows that do carry `product_id` are filtered here as well.
 */
export function chartPositions(
  positions: readonly unknown[] | undefined,
  position: Record<string, unknown>,
  productId = 'PF_XBTUSD',
): Record<string, unknown>[] {
  const list = (positions ?? []).map(recordOf)
  const own = list.filter(
    (item) =>
      (item.side === 'long' || item.side === 'short') &&
      (item.product_id === undefined || item.product_id === productId),
  )
  if (positions !== undefined) return own
  return position.side === 'long' || position.side === 'short' ? [position] : []
}
