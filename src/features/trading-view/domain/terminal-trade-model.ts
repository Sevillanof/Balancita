export interface TerminalChartTrade {
  product: string
  tradeNo: number
  side: 'LONG' | 'SHORT'
  open: boolean
  entryMs: number
  exitMs: number | null
  entryPrice: number | null
  exitPrice: number | null
  markPrice: number | null
  markMs?: number | null
  netUsd: number | null
  fundingComplete: boolean
}

export type TradeTone = 'gain' | 'loss' | 'neutral' | 'unknown' | 'provisional'
export type TradeSpan =
  | { state: 'unavailable'; reason: string }
  | {
      state: 'ready'
      id: string
      startMs: number
      endMs: number
      price: number
    }

export function tradeIdentity(trade: TerminalChartTrade): string {
  return `terminal:${trade.product}:${trade.tradeNo}`
}

export function readTradeSpan(
  trade: TerminalChartTrade,
  lastMarketMs: number,
): TradeSpan {
  if (
    trade.entryPrice === null ||
    !Number.isFinite(trade.entryPrice) ||
    trade.entryPrice <= 0
  )
    return {
      state: 'unavailable',
      reason: 'Falta un precio de entrada registrado válido.',
    }
  if (!Number.isSafeInteger(trade.entryMs) || trade.entryMs < 0)
    return {
      state: 'unavailable',
      reason: 'Falta una hora de entrada registrada válida.',
    }
  let endMs = Math.max(trade.entryMs, lastMarketMs)
  if (!trade.open) {
    const exitMs = trade.exitMs
    if (
      exitMs === null ||
      !Number.isSafeInteger(exitMs) ||
      exitMs < trade.entryMs
    )
      return {
        state: 'unavailable',
        reason: 'Falta una hora de cierre registrada válida.',
      }
    endMs = exitMs
  }
  return {
    state: 'ready',
    id: tradeIdentity(trade),
    startMs: trade.entryMs,
    endMs,
    price: trade.entryPrice,
  }
}

export function tradeTone(
  trade: TerminalChartTrade,
  confirmed: boolean,
): TradeTone {
  if (!confirmed || trade.netUsd === null) return 'unknown'
  if (!trade.fundingComplete) return 'provisional'
  return trade.netUsd > 0 ? 'gain' : trade.netUsd < 0 ? 'loss' : 'neutral'
}

export function tradeHistoryNotice(
  trade: TerminalChartTrade,
  firstMarketMs: number,
): string | null {
  if (!trade.open && trade.exitMs !== null && trade.exitMs < firstMarketMs)
    return `Operación #${trade.tradeNo}: no hay velas de su período en este intervalo. Probá uno más amplio; no se inventan datos.`
  if (trade.entryMs < firstMarketMs)
    return `Operación #${trade.tradeNo}: la entrada es anterior al historial disponible. La línea conserva su precio registrado.`
  return null
}

/** Fractional logical position preserves the recorded instant, including between aggregated candles. */
export function timeLogicalIndex(
  times: readonly number[],
  timeMs: number,
  intervalSeconds: number,
): number | null {
  if (times.length === 0) return null
  const seconds = timeMs / 1000
  if (seconds < times[0]!) return (seconds - times[0]!) / intervalSeconds
  const last = times.length - 1
  if (seconds >= times[last]!)
    return last + (seconds - times[last]!) / intervalSeconds
  let low = 0
  let high = last
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (times[middle]! <= seconds) low = middle
    else high = middle
  }
  return low + (seconds - times[low]!) / (times[high]! - times[low]!)
}

export interface TradeCoordinates {
  id: string
  trade: TerminalChartTrade
  startMs: number
  endMs: number
  startX: number
  endX: number
  entryY: number
  entryX: number
  entryVisible: boolean
  resultX: number | null
  resultY: number | null
  resultVisible: boolean
  area: readonly { x: number; y: number }[]
}

export interface TradeCoordinateMap {
  width: number
  height: number
  time: (timeMs: number) => number | null
  price: (price: number) => number | null
}

export interface TradeLabelRect {
  left: number
  top: number
  width: number
  height: number
}

export interface TradeLabelLayout {
  item: TradeCoordinates
  entry: TradeLabelRect | null
  result: TradeLabelRect | null
}

/** Pill sizes of the single per-operation label (the selected one shows two more lines of detail). */
export const TRADE_PILL_HEIGHT = 26
export const TRADE_PILL_SELECTED_HEIGHT = 62
const TRADE_PILL_GAP = 6
const TRADE_PILL_EDGE = 4

export function tradePillWidth(width: number): number {
  return width < 500 ? 108 : 136
}

/** «2 h 10 m», «45 m», «3 d 4 h»: how long an operation has been open (or was). */
export function formatTradeDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes} m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${minutes % 60} m`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/**
 * One label per operation, stacked in a column at the right edge of the chart, each
 * as close as possible to the height of its own entry line, with a fixed gap so
 * labels never overlap however many operations are open. The selected operation
 * expands in place; whatever does not fit in the column gets `entry: null`.
 */
export function layoutTradeLabels(
  items: readonly TradeCoordinates[],
  width: number,
  height: number,
  selectedId: string,
): TradeLabelLayout[] {
  const pillWidth = tradePillWidth(width)
  const left = Math.max(TRADE_PILL_EDGE, width - pillWidth - TRADE_PILL_EDGE)
  const slots = items
    .map((item) => ({
      item,
      height:
        item.id === selectedId ? TRADE_PILL_SELECTED_HEIGHT : TRADE_PILL_HEIGHT,
      top: 0,
    }))
    .sort((a, b) => a.item.entryY - b.item.entryY)
  let floor = TRADE_PILL_EDGE
  for (const slot of slots) {
    slot.top = Math.max(slot.item.entryY - slot.height / 2, floor)
    floor = slot.top + slot.height + TRADE_PILL_GAP
  }
  let ceiling = height - TRADE_PILL_EDGE
  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index]!
    slot.top = Math.min(slot.top, ceiling - slot.height)
    ceiling = slot.top - TRADE_PILL_GAP
  }
  const fits = width >= pillWidth + 2 * TRADE_PILL_EDGE
  const boxes = new Map<string, TradeLabelRect | null>(
    slots.map((slot) => [
      slot.item.id,
      fits && slot.top >= TRADE_PILL_EDGE
        ? { left, top: slot.top, width: pillWidth, height: slot.height }
        : null,
    ]),
  )
  return items.map((item) => ({
    item,
    entry: boxes.get(item.id) ?? null,
    result: null,
  }))
}

export function projectTrade(
  trade: TerminalChartTrade,
  span: Extract<TradeSpan, { state: 'ready' }>,
  map: TradeCoordinateMap,
  candles: readonly { time: number; close: number }[],
): TradeCoordinates | null {
  const start = map.time(span.startMs)
  const end = map.time(span.endMs)
  const entryY = map.price(span.price)
  if (
    start === null ||
    end === null ||
    entryY === null ||
    end < 0 ||
    start > map.width
  )
    return null
  const resultTime = trade.open ? (trade.markMs ?? span.endMs) : span.endMs
  const resultPrice = trade.open ? trade.markPrice : trade.exitPrice
  const resultX = map.time(resultTime)
  const resultY = resultPrice === null ? null : map.price(resultPrice)
  const area = candles.flatMap((candle) => {
    if (candle.time * 1000 < span.startMs || candle.time * 1000 > span.endMs)
      return []
    const x = map.time(candle.time * 1000)
    const y = map.price(candle.close)
    return x !== null && y !== null && x >= 0 && x <= map.width
      ? [{ x, y }]
      : []
  })
  return {
    id: span.id,
    trade,
    startMs: span.startMs,
    endMs: span.endMs,
    startX: Math.max(0, start),
    endX: Math.min(map.width, end),
    entryY,
    entryX: start,
    entryVisible: start >= 0 && start <= map.width,
    resultX,
    resultY,
    resultVisible:
      resultX !== null &&
      resultY !== null &&
      resultX >= 0 &&
      resultX <= map.width,
    area,
  }
}
