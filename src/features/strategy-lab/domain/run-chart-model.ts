import type {
  ApprovedTerminalCandle,
  ApprovedTerminalMarker,
  ApprovedChartPriceLine,
} from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import type { RunCandle, RunTrade } from '../infrastructure/run-visual-api.ts'

const MINUTE_MS = 60_000
/** Candles shown on each side of a selected trade. */
export const CONTEXT_MS = 2 * 60 * MINUTE_MS

export function toChartCandles(
  candles: readonly RunCandle[],
): ApprovedTerminalCandle[] {
  return candles.flatMap((candle) => {
    const values = [
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
    ].map(Number)
    if (
      !Number.isFinite(candle.time_ms) ||
      values.some((n) => !Number.isFinite(n))
    )
      return []
    return [
      {
        time: Math.floor(candle.time_ms / 1000),
        open: values[0]!,
        high: values[1]!,
        low: values[2]!,
        close: values[3]!,
        volume: values[4]!,
      },
    ]
  })
}

const entrySeconds = (trade: RunTrade) =>
  Math.floor((trade.entry_bucket_ms ?? trade.entry_time_ms) / MINUTE_MS) * 60
// A trade ends at the close of its exit candle: its marker belongs to that candle.
const exitSeconds = (trade: RunTrade) =>
  trade.exit_bucket_ms != null
    ? Math.floor(trade.exit_bucket_ms / MINUTE_MS) * 60
    : Math.floor((trade.exit_time_ms - 1) / MINUTE_MS) * 60

export const markerIds = (trade: RunTrade) => ({
  entry: `${trade.trade_id}:entry`,
  exit: `${trade.trade_id}:exit`,
})

/** The trade a marker id belongs to (`<trade_id>:entry|exit`), or `null`. */
export function tradeOfMarker(markerId: string | undefined): string | null {
  if (!markerId) return null
  const cut = markerId.lastIndexOf(':')
  return cut > 0 ? markerId.slice(0, cut) : null
}

/** Entry (L/S) and exit (×) markers; only trades that really closed exist here, none is invented. */
export function toMarkers(
  trades: readonly RunTrade[],
): ApprovedTerminalMarker[] {
  return trades.flatMap((trade) => {
    const ids = markerIds(trade)
    const long = trade.side === 'LONG'
    return [
      {
        id: ids.entry,
        time: entrySeconds(trade),
        type: 'entry' as const,
        direction: long ? ('long' as const) : ('short' as const),
        label: long ? 'L' : 'S',
        detail: `Entrada ${long ? 'LONG' : 'SHORT'}`,
        positionId: trade.trade_id,
      },
      {
        id: ids.exit,
        time: exitSeconds(trade),
        type: 'exit' as const,
        direction: 'flat' as const,
        label: '×',
        detail: `Salida (${trade.exit_reason ?? 'sin motivo'})`,
        positionId: trade.trade_id,
      },
    ]
  })
}

/** Entry and exit prices of the selected trade as horizontal lines (modelled fills, not quotes). */
export function priceLinesOf(trade: RunTrade | null): ApprovedChartPriceLine[] {
  if (!trade) return []
  const lines: ApprovedChartPriceLine[] = []
  const entry = Number(trade.entry_price)
  const exit = Number(trade.exit_price)
  if (trade.entry_price != null && Number.isFinite(entry))
    lines.push({
      id: `${trade.trade_id}:entry-price`,
      price: entry,
      title: `${trade.side === 'LONG' ? 'L' : 'S'} entrada`,
      color: trade.side === 'LONG' ? '#55c7a2' : '#ee7777',
      dashed: true,
    })
  if (trade.exit_price != null && Number.isFinite(exit))
    lines.push({
      id: `${trade.trade_id}:exit-price`,
      price: exit,
      title: '× salida',
      color: '#d4aa62',
      dashed: true,
    })
  return lines
}

/** The window of candles to load around a trade. */
export function windowAround(trade: RunTrade) {
  return {
    from: trade.entry_time_ms - CONTEXT_MS,
    to: trade.exit_time_ms + CONTEXT_MS,
  }
}

const MADRID = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** `19/10/2026, 14:05` in Madrid time. */
export function madridTime(ms: number): string {
  return MADRID.format(new Date(ms))
}

/** `1 h 15 min`, `12 min`. */
export function holdText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

const REASONS: Record<string, string> = {
  stop: 'Stop',
  target: 'Objetivo',
  time_stop: 'Tiempo cumplido',
}

export function exitReasonText(reason: string | null): string {
  if (!reason) return 'Sin motivo registrado'
  return REASONS[reason] ?? reason
}

const FUNDING: Record<string, string> = {
  complete: 'Funding completo',
  partial: 'Funding parcial',
  unknown: 'Funding incompleto',
}
export const fundingText = (status: string) => FUNDING[status] ?? status
