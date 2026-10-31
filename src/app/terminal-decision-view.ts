import { record } from '../shared/wire/decode.ts'
import { percent } from './qwen-wait-reason.ts'

/** What the engine did at one look, in the few words the Terminal paints. */
export type DecisionKind =
  | 'enter-long'
  | 'enter-short'
  | 'wait'
  | 'blocked'
  | 'hold'
  | 'exit'
  | 'skipped'

export type DecisionView = {
  kind: DecisionKind
  /** Two or three words: «Entra largo», «Espera», «Portero frena»… */
  label: string
  motivo: string | null
  /** The master's verdict, -2 (strong down) to +2 (strong up); null when unknown. */
  master: number | null
  /** The keeper let the entry through (true), stopped it (false), or is unknown. */
  gate: boolean | null
  /** The news analyst enabled the entry (true), did not (false), or is unknown. */
  news?: boolean | null
  newsDirection?: 'bullish' | 'bearish' | 'neutral' | null
  newsAvailable?: boolean | null
  /** Qwen's opinion next to the formulas; null before version 9 or on a skipped look. */
  opinion: {
    state: 'agrees' | 'differs' | 'none'
    label: string | null
    side: 'long' | 'short' | 'flat' | null
    p: string | null
  } | null
  /** Worth keeping apart from the quiet waits (entry, exit, a stopped entry, Qwen disagreeing, no data). */
  relevant: boolean
}

export const KIND_LABEL: Record<DecisionKind, string> = {
  'enter-long': 'Entra largo',
  'enter-short': 'Entra corto',
  wait: 'Espera',
  blocked: 'Portero frena',
  hold: 'Mantiene',
  exit: 'Sale',
  skipped: 'Sin decisión',
}

const OPINION_LABEL: Record<string, string> = {
  LARGO: 'largo',
  CORTO: 'corto',
  ESPERAR: 'esperar',
  MANTENER: 'mantener',
  CERRAR: 'cerrar',
}

function sideOf(action: string): 'long' | 'short' | 'flat' {
  return action === 'LARGO' ? 'long' : action === 'CORTO' ? 'short' : 'flat'
}

function opinionOf(row: Record<string, unknown>): DecisionView['opinion'] {
  if (typeof row.formula_action !== 'string' || !row.formula_action) return null
  if (record(row.formula).opinion_enabled === false) return null
  const action = typeof row.model_action === 'string' ? row.model_action : null
  if (!action) return { state: 'none', label: null, side: null, p: null }
  return {
    state: row.opinion_agrees === 1 ? 'agrees' : 'differs',
    label: OPINION_LABEL[action] ?? action.toLowerCase(),
    side: sideOf(action),
    p: percent(row.p_action),
  }
}

/** The pictures-first reading of one analysis; older rows (no formula) still get an honest kind from their action. */
export function decisionView(analysis: Record<string, unknown>): DecisionView {
  const formula = record(analysis.formula)
  const master =
    typeof formula.maestro === 'number' && Number.isFinite(formula.maestro)
      ? formula.maestro
      : null
  const gate =
    typeof formula.portero_si === 'boolean' ? formula.portero_si : null
  const news =
    typeof formula.noticias_si === 'boolean' ? formula.noticias_si : null
  const newsInfo = record(formula.noticias)
  const newsAvailable =
    typeof newsInfo.disponible === 'boolean' ? newsInfo.disponible : null
  const signal = record(newsInfo.signal)
  const sentiment =
    typeof signal.side === 'number'
      ? signal.side
      : typeof newsInfo.sentimiento === 'number' &&
          Number.isFinite(newsInfo.sentimiento)
        ? newsInfo.sentimiento
        : null
  const newsDirection =
    newsAvailable === false || sentiment === null
      ? null
      : sentiment > 0
        ? 'bullish'
        : sentiment < 0
          ? 'bearish'
          : 'neutral'
  const opinion = opinionOf(analysis)
  const make = (kind: DecisionKind): DecisionView => ({
    kind,
    label: KIND_LABEL[kind],
    motivo: typeof formula.motivo === 'string' ? formula.motivo : null,
    master,
    gate,
    news,
    newsDirection,
    newsAvailable,
    opinion,
    relevant:
      kind === 'enter-long' ||
      kind === 'enter-short' ||
      kind === 'exit' ||
      kind === 'blocked' ||
      kind === 'skipped' ||
      opinion?.state === 'differs',
  })
  if (analysis.qwen_skipped === true) return make('skipped')
  const formulaAction = analysis.formula_action
  if (typeof formulaAction === 'string' && formulaAction) {
    if (formulaAction === 'LARGO') return make('enter-long')
    if (formulaAction === 'CORTO') return make('enter-short')
    if (formulaAction === 'CERRAR') return make('exit')
    if (formulaAction === 'MANTENER') return make('hold')
    return make(
      String(formula.motivo ?? '').includes('portero') ? 'blocked' : 'wait',
    )
  }
  const action = String(
    analysis.action ?? record(analysis.selector).action ?? 'WAIT',
  ).toUpperCase()
  if (action === 'LONG') return make('enter-long')
  if (action === 'SHORT') return make('enter-short')
  if (action === 'CLOSE') return make('exit')
  return make(analysis.reason_code === 'qwen_MANTENER' ? 'hold' : 'wait')
}

/** «▲▲» strong up, «▲» weak up, «–» flat, «▼▼», «▼». */
export function masterGlyph(master: number | null): string {
  if (master === null) return '?'
  if (master >= 2) return '▲▲'
  if (master === 1) return '▲'
  if (master === 0) return '–'
  return master <= -2 ? '▼▼' : '▼'
}
