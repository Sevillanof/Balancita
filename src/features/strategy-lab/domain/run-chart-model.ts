import type {
  ApprovedTerminalCandle,
  ApprovedTerminalMarker,
  ApprovedChartPriceLine,
} from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import type {
  RunCandle,
  RunSignal,
  RunTrade,
} from '../infrastructure/run-visual-api.ts'

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
        label: trade.exit_reason
          ? `× ${REASON_SHORT[trade.exit_reason] ?? ''}`.trim()
          : '×',
        detail: `Salida (${exitReasonText(trade.exit_reason)})`,
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

/** Exit reasons the simulator books: `stop`, `target`, `time_stop`, `strategy_exit` (futures_simulator._manage). */
const REASONS: Record<string, string> = {
  stop: 'Stop',
  target: 'Objetivo',
  time_stop: 'Tiempo cumplido',
  strategy_exit: 'Regla de salida de la estrategia',
}
/** Short word painted next to the × of the exit. */
const REASON_SHORT: Record<string, string> = {
  stop: 'stop',
  target: 'objetivo',
  time_stop: 'tiempo',
  strategy_exit: 'regla',
}

export function exitReasonText(reason: string | null): string {
  if (!reason) return 'Sin motivo registrado'
  return REASONS[reason] ?? reason
}

/**
 * What became of a LONG/SHORT proposal that was not taken, by the trace's `outcome` (gate_trace.TracedBook):
 * `position_open`, `rejected_stale_data`, `rejected_<reason of Book.skipped>` (`target_does_not_clear_cost`,
 * `protective_levels_unavailable`) and `rejected_unknown`. `accepted` is an entry, not a discard.
 */
const DISCARDS: Record<string, string> = {
  position_open: 'ya había una posición abierta',
  rejected_stale_data: 'los datos estaban desactualizados',
  rejected_target_does_not_clear_cost: 'el objetivo no cubría los costes',
  rejected_protective_levels_unavailable:
    'no se pudieron calcular el stop y el objetivo',
  rejected_unknown: 'la prueba no guardó el motivo',
}

/** Spanish reason of a discard; an outcome this table does not know is said so, never guessed. */
export function discardReasonText(outcome: string): string {
  return DISCARDS[outcome] ?? `motivo sin traducir («${outcome}»)`
}

/** Discards of a window above this many are grouped so the chart does not fill up. */
export const MAX_SINGLE_DISCARDS = 150
const DISCARD_BINS = 40

const discardId = (signal: RunSignal) => `d:${signal.bucket_ms}`

/** Id of a discard marker (single or grouped). */
export const isDiscardId = (id: string | undefined): boolean =>
  id !== undefined && id.startsWith('d:')

/**
 * Neutral markers for the proposals that were NOT taken, only inside the visible window. Up to 150 they are one
 * marker each; above that they are grouped in time bins and labelled `+N`. Uses the grey circle (`wait`) of the
 * approved chart: no new marker type, and it cannot be mistaken for an L/S arrow or an exit.
 */
export function toDiscardMarkers(
  signals: readonly RunSignal[],
  window: { from: number; to: number },
): ApprovedTerminalMarker[] {
  const inside = signals
    .filter(
      (signal) =>
        signal.outcome !== 'accepted' &&
        signal.bucket_ms >= window.from &&
        signal.bucket_ms < window.to,
    )
    .sort((a, b) => a.bucket_ms - b.bucket_ms)
  const single = (signal: RunSignal): ApprovedTerminalMarker => ({
    id: discardId(signal),
    time: Math.floor(signal.bucket_ms / MINUTE_MS) * 60,
    type: 'wait',
    direction: 'flat',
    label: '',
    detail: `Descarte ${signal.side}: ${discardReasonText(signal.outcome)}`,
  })
  if (inside.length <= MAX_SINGLE_DISCARDS) return inside.map(single)
  const width = Math.max(
    MINUTE_MS,
    Math.ceil((window.to - window.from) / DISCARD_BINS),
  )
  const bins = new Map<number, RunSignal[]>()
  for (const signal of inside) {
    const key = Math.floor((signal.bucket_ms - window.from) / width)
    bins.set(key, [...(bins.get(key) ?? []), signal])
  }
  return [...bins.values()].map((group) => {
    if (group.length === 1) return single(group[0]!)
    const byReason = new Map<string, number>()
    for (const signal of group)
      byReason.set(
        discardReasonText(signal.outcome),
        (byReason.get(discardReasonText(signal.outcome)) ?? 0) + 1,
      )
    const parts = [...byReason].map(([reason, n]) => `${n} porque ${reason}`)
    return {
      id: `d:g:${group[0]!.bucket_ms}`,
      time: Math.floor(group[0]!.bucket_ms / MINUTE_MS) * 60,
      type: 'wait' as const,
      direction: 'flat' as const,
      label: `+${group.length}`,
      detail: `+${group.length} descartes: ${parts.join(', ')}`,
      count: group.length,
      memberIds: group.map(discardId),
    }
  })
}

const FUNDING: Record<string, string> = {
  complete: 'Funding completo',
  partial: 'Funding parcial',
  unknown: 'Funding incompleto',
}
export const fundingText = (status: string) => FUNDING[status] ?? status
