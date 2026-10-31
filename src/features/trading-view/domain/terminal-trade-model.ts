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

function labelsOverlap(a: TradeLabelRect, b: TradeLabelRect): boolean {
  return (
    a.left < b.left + b.width + 4 &&
    a.left + a.width + 4 > b.left &&
    a.top < b.top + b.height + 4 &&
    a.top + a.height + 4 > b.top
  )
}

function placeTradeLabel(
  preferred: TradeLabelRect,
  width: number,
  height: number,
  occupied: TradeLabelRect[],
): TradeLabelRect | null {
  if (preferred.width + 8 > width || preferred.height + 8 > height) return null
  const clampX = (x: number) =>
    Math.max(4, Math.min(width - preferred.width - 4, x))
  const clampY = (y: number) =>
    Math.max(4, Math.min(height - preferred.height - 4, y))
  const step = preferred.height + 6
  const columns = [
    preferred.left,
    preferred.left - preferred.width - 6,
    preferred.left + preferred.width + 6,
    4,
    width - preferred.width - 4,
  ].map(clampX)
  for (let row = 0; row <= Math.ceil(height / step); row++) {
    const tops =
      row === 0
        ? [clampY(preferred.top)]
        : [
            clampY(preferred.top - row * step),
            clampY(preferred.top + row * step),
          ]
    for (const top of tops)
      for (const left of columns) {
        const box = { ...preferred, left, top }
        if (!occupied.some((other) => labelsOverlap(box, other))) {
          occupied.push(box)
          return box
        }
      }
  }
  return null
}

export function layoutTradeLabels(
  items: readonly TradeCoordinates[],
  width: number,
  height: number,
  selectedId: string,
): TradeLabelLayout[] {
  const occupied: TradeLabelRect[] = []
  const ordered = [...items].sort(
    (a, b) => Number(b.id === selectedId) - Number(a.id === selectedId),
  )
  return ordered.map((item) => {
    const long = item.trade.side === 'LONG'
    const reversal = items.some(
      (other) =>
        other.id !== item.id && other.trade.exitMs === item.trade.entryMs,
    )
    const entry = placeTradeLabel(
      {
        left: item.entryVisible ? item.entryX - 52 : 4,
        top:
          item.entryY + (long ? 21 : -53) + (reversal ? (long ? 36 : -36) : 0),
        width: item.entryVisible ? 104 : 140,
        height: 32,
      },
      width,
      height,
      occupied,
    )
    const result =
      item.resultVisible && item.resultX !== null && item.resultY !== null
        ? placeTradeLabel(
            {
              left: item.resultX - 72,
              top:
                width < 500
                  ? item.trade.open
                    ? 7
                    : item.resultY + 13
                  : item.resultY - 43,
              width: 144,
              height: 30,
            },
            width,
            height,
            occupied,
          )
        : null
    return { item, entry, result }
  })
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
