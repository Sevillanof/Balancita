import { amount, madridDayTime, madridTime } from '../shared/finance/format.ts'
import type { MasterReading } from './terminal-lifecycle.ts'
import type { QwenTrade } from './useQwenTrades.ts'

/**
 * What the operation card draws, computed from the trade and the latest look:
 * the ring of hours held against the cap, the range bar (worst and best since
 * entry) and the three exit rules. A value the data does not carry is `null`
 * (the card says «sin dato»), never filled in.
 */

const MIN_MS = 60_000
const HOUR_MS = 3_600_000
/** After this long the maestro is checked for exhaustion («agotado»). */
export const EXHAUST_MS = 24 * HOUR_MS
/** The cap of the maestro's operations; the rebound expert brings its own. */
export const CAP_MS = 36 * HOUR_MS

/** `+5,02 US$`, `−4,20 US$`, `0,00 US$`: a comma, an explicit sign and a real minus. */
export function usdSigned(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${amount(Math.abs(value))} US$`
}

/** `23 h 9 min`, `50 min`. */
function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MIN_MS))
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
    : `${minutes} min`
}

const capHours = (capMs: number): string => amount(capMs / HOUR_MS, 0)

export interface HoldView {
  /** 0..1 of the cap. */
  fraction: number
  /** Where the 24 h check sits on the ring (0..1), or null when the cap is not longer than 24 h. */
  exhaustMark: number | null
  /** The center of the ring: `23h`, `42m`, `—`. */
  label: string
  /** `23 h 9 min de 36 h`, or why there is nothing to count. */
  text: string
  capMs: number
}

/** The hours the operation has been open (or was, once closed) against its cap. */
export function holdView(trade: QwenTrade, nowMs: number): HoldView {
  const capMs =
    trade.maxHoldMs != null && trade.maxHoldMs > 0 ? trade.maxHoldMs : CAP_MS
  const exhaustMark = EXHAUST_MS < capMs ? EXHAUST_MS / capMs : null
  const end = trade.open ? nowMs : trade.exitMs
  if (end === null || end < trade.entryMs)
    return {
      fraction: 0,
      exhaustMark,
      label: '—',
      text: 'Duración no registrada',
      capMs,
    }
  const held = end - trade.entryMs
  return {
    fraction: Math.min(1, held / capMs),
    exhaustMark,
    label:
      held >= HOUR_MS
        ? `${Math.floor(held / HOUR_MS)}h`
        : `${Math.floor(held / MIN_MS)}m`,
    text: `${span(held)} de ${capHours(capMs)} h`,
    capMs,
  }
}

export interface RangeView {
  worstUsd: number
  bestUsd: number
  nowUsd: number | null
  /** 0..1 along the bar: where the 0 tick is. */
  zero: number
  /** 0..1 along the bar: where the net is now (held at the edges); null when the net is unknown. */
  now: number | null
  tip: string
}

/**
 * The worst and best the price went for the operation since its entry, as US$
 * of its size (basis points × notional), with the net now placed between them.
 * Null (sin dato) when the gateway has no excursion or the size is unknown, and
 * when the price has not moved yet (a bar with no length says nothing).
 */
export function rangeView(trade: QwenTrade): RangeView | null {
  const { mfeBp, maeBp, notionalUsd } = trade
  if (mfeBp == null || maeBp == null || notionalUsd == null) return null
  const worstUsd = Math.min(0, (maeBp / 10_000) * notionalUsd)
  const bestUsd = Math.max(0, (mfeBp / 10_000) * notionalUsd)
  const width = bestUsd - worstUsd
  if (!(width > 0)) return null
  const nowUsd = trade.netUsd
  const now =
    nowUsd === null
      ? null
      : Math.min(1, Math.max(0, (nowUsd - worstUsd) / width))
  return {
    worstUsd,
    bestUsd,
    nowUsd,
    zero: -worstUsd / width,
    now,
    tip: `Desde que entró, lo peor que llegó a ir fue ${usdSigned(worstUsd)} y lo mejor ${usdSigned(bestUsd)} (movimiento del precio sobre el tamaño, antes de costes). La raya es el 0${nowUsd === null ? '' : `; el marcador es el neto ahora, ${usdSigned(nowUsd)}, ya con costes`}.`,
  }
}

export type RuleId = 'master' | 'exhaust' | 'cap'

export type RuleState =
  | 'favor'
  | 'contra'
  | 'neutral'
  | 'sin_dato'
  | 'espera'
  | 'activo'
  | 'no_aplica'
  | 'llego'

export interface RuleView {
  id: RuleId
  /** Accessible name of the icon. */
  label: string
  state: RuleState
  /** 0..1 of the thin bar under the icon; null when there is nothing to measure. */
  progress: number | null
  /** The detail, shown only in the tooltip. */
  tip: string
}

const sideWord = (side: 'LONG' | 'SHORT') =>
  side === 'LONG' ? 'largo' : 'corto'

const comma = (value: number): string =>
  `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(2).replace('.', ',')}`

/** Which way the maestro leans against the operation: the score's sign, else the verdict's. */
function masterState(
  trade: QwenTrade,
  reading: MasterReading | null,
): 'favor' | 'contra' | 'neutral' | 'sin_dato' {
  const side = trade.side === 'LONG' ? 1 : -1
  const lean =
    reading?.score != null
      ? side * reading.score
      : reading?.master != null
        ? side * reading.master
        : null
  return lean === null
    ? 'sin_dato'
    : lean > 0
      ? 'favor'
      : lean < 0
        ? 'contra'
        : 'neutral'
}

/**
 * The three exit rules of an open operation, each with its state and a thin
 * progress bar: the maestro for or against it, the «agotado» check at 24 h and
 * the cap. A closed operation has no rules left to wait for: empty.
 */
export function ruleViews(
  trade: QwenTrade,
  nowMs: number,
  master: MasterReading | null,
): RuleView[] {
  if (!trade.open) return []
  const held = Math.max(0, nowMs - trade.entryMs)
  const capMs =
    trade.maxHoldMs != null && trade.maxHoldMs > 0 ? trade.maxHoldMs : CAP_MS
  const side = sideWord(trade.side)
  const lean = masterState(trade, master)
  const seen =
    master === null
      ? ''
      : `, mirada de las ${madridTime(master.atMs)} (hora de Madrid)`
  const score = master?.score == null ? '' : `puntaje ${comma(master.score)}`
  const verdict = trade.side === 'LONG' ? 1 : -1
  const masterRule: RuleView = {
    id: 'master',
    label: 'Maestro',
    state: lean,
    progress:
      master?.master == null
        ? null
        : Math.min(1, Math.max(0, (verdict * master.master + 2) / 4)),
    tip:
      lean === 'sin_dato'
        ? 'Maestro: sin dato (todavía no hay una mirada con puntaje).'
        : lean === 'favor'
          ? `El maestro sigue a favor del ${side} (${score}${seen}). Mientras no se dé vuelta, la operación sigue.`
          : lean === 'contra'
            ? `El maestro va en contra del ${side} (${score}${seen}). Si se da vuelta, la fórmula cierra la operación.`
            : `El maestro no se inclina hacia ningún lado (${score}${seen}).`,
  }
  const exhaustLabel = 'Maestro agotado'
  const exhaustAt = trade.entryMs + EXHAUST_MS
  const exhaustRule: RuleView =
    EXHAUST_MS >= capMs
      ? {
          id: 'exhaust',
          label: exhaustLabel,
          state: 'no_aplica',
          progress: null,
          tip: `Agotado: no aplica, esta operación sale como mucho a las ${capHours(capMs)} h.`,
        }
      : held < EXHAUST_MS
        ? {
            id: 'exhaust',
            label: exhaustLabel,
            state: 'espera',
            progress: held / EXHAUST_MS,
            tip: `Agotado: a las 24 h (${madridDayTime(exhaustAt, nowMs)}, hora de Madrid) la operación cierra si el maestro deja de ir a favor · faltan ${span(EXHAUST_MS - held)}.`,
          }
        : {
            id: 'exhaust',
            label: exhaustLabel,
            state: 'activo',
            progress: 1,
            tip: `Agotado: activo desde las ${madridDayTime(exhaustAt, nowMs)} (hora de Madrid). Cierra si el maestro deja de ir a favor; ahora ${lean === 'favor' ? 'va a favor' : lean === 'contra' ? 'va en contra' : lean === 'neutral' ? 'no se inclina' : 'está sin dato'}.`,
          }
  const capAt = trade.entryMs + capMs
  const capRule: RuleView = {
    id: 'cap',
    label: 'Tope de tiempo',
    state: held >= capMs ? 'llego' : 'espera',
    progress: Math.min(1, held / capMs),
    tip:
      held >= capMs
        ? `Tope de ${capHours(capMs)} h alcanzado (${madridDayTime(capAt, nowMs)}, hora de Madrid): cierra en la próxima mirada.`
        : `Tope: cierre obligatorio a las ${capHours(capMs)} h (${madridDayTime(capAt, nowMs)}, hora de Madrid) · faltan ${span(capMs - held)}.`,
  }
  return [masterRule, exhaustRule, capRule]
}
