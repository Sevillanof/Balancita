import { record } from '../shared/wire/decode.ts'
import { decisionView, masterGlyph } from './terminal-decision-view.ts'
import type { QwenTrade } from './useQwenTrades.ts'

/**
 * The lifecycle strip of the chart bar: the steps a new entry goes through
 * (no open operation) or the exit rules of the open one, each with the data of
 * its last evaluation. Everything is read from what the Terminal already has
 * (Qwen's decisions and the open trade); a missing value is said, never filled.
 */

export type StepTone = 'ok' | 'no' | 'warn' | 'info' | 'na'

export type StepIcon =
  | 'eye'
  | 'master'
  | 'gate'
  | 'news'
  | 'enter'
  | 'flip'
  | 'clock12'
  | 'clock24'
  | 'cap'
  | 'maker'
  | 'alert'

export interface LifecycleStep {
  id: string
  icon: StepIcon
  label: string
  tone: StepTone
  /** The state word of the pill when the tone's own word does not fit. */
  word?: string
  /** One short line: what this step said at its last evaluation. */
  headline: string
  /** The numbers behind it, label / value pairs. */
  rows: readonly { label: string; value: string }[]
  /** A bar 0..1 with an optional mark (the threshold) when the step is a quantity. */
  meter: { value: number; mark: number | null; caption: string } | null
  /** Tone of the same step at the last evaluations, oldest first. */
  history: readonly StepTone[]
  /** The step's rule in plain words. */
  rule: string
}

export interface LifecycleView {
  phase: 'entry' | 'exit'
  steps: readonly LifecycleStep[]
  /** Instant of the evaluation the strip shows. */
  evaluatedMs: number
}

const HISTORY = 8
const HOUR_MS = 3_600_000
const EXHAUST_H = 24
const CAP_H = 36
const NEWS_H = 12

const clock = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function madridTime(ms: number): string {
  return clock.format(new Date(ms))
}

function hours(ms: number): string {
  return `${(ms / HOUR_MS).toFixed(1).replace('.', ',')} h`
}

const comma = (value: number): string => value.toFixed(2).replace('.', ',')

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

type Read = {
  master: number | null
  score: number | null
  gate: boolean | null
  gateP: number | null
  gateSide: number | null
  news: boolean | null
  newsStatus: string | null
  motivo: string | null
  skipped: boolean
}

function read(analysis: Record<string, unknown>): Read {
  const formula = record(analysis.formula)
  const independent = record(formula.portero_autonomo)
  const priority = record(record(formula.noticias).priority)
  return {
    master: num(formula.maestro),
    score: num(formula.puntaje),
    gate: typeof formula.portero_si === 'boolean' ? formula.portero_si : null,
    gateP: num(formula.portero_p),
    gateSide: num(independent.side),
    news: typeof formula.noticias_si === 'boolean' ? formula.noticias_si : null,
    newsStatus: typeof priority.status === 'string' ? priority.status : null,
    motivo: typeof formula.motivo === 'string' ? formula.motivo : null,
    skipped: analysis.qwen_skipped === true,
  }
}

function entryStepsOf(analysis: Record<string, unknown>): LifecycleStep[] {
  const r = read(analysis)
  const view = decisionView(analysis)
  const when = num(analysis.decision_time_ms)
  const strong = r.master !== null && Math.abs(r.master) >= 2
  const masterSide = r.master === null ? null : Math.sign(r.master)
  const gateTone: StepTone =
    r.gate === null && r.gateSide === null
      ? 'na'
      : r.gateSide !== null
        ? masterSide !== null && r.gateSide * masterSide > 0
          ? 'ok'
          : 'no'
        : r.gate
          ? 'ok'
          : 'no'
  const newsTone: StepTone =
    r.news === true ? 'ok' : r.newsStatus === 'conflict' ? 'warn' : 'na'
  const entered = view.kind === 'enter-long' || view.kind === 'enter-short'
  return [
    {
      id: 'look',
      icon: 'eye',
      label: 'Mira el mercado',
      tone: r.skipped ? 'no' : 'ok',
      headline: r.skipped
        ? 'No pudo decidir esta vez'
        : 'Datos completos, miró el mercado',
      rows: [
        {
          label: 'Última mirada',
          value: when === null ? 'sin dato' : madridTime(when),
        },
        ...(r.skipped && typeof analysis.qwen_why === 'string'
          ? [{ label: 'Motivo', value: analysis.qwen_why }]
          : []),
      ],
      meter: null,
      history: [],
      rule: 'Cada 15 min, con velas de 5 min cerradas. Con datos incompletos no decide.',
    },
    {
      id: 'master',
      icon: 'master',
      label: 'Maestro',
      tone: r.master === null ? 'na' : strong ? 'ok' : 'warn',
      headline:
        r.master === null
          ? 'Sin lectura'
          : strong
            ? `Fuerte a favor del ${r.master > 0 ? 'largo' : 'corto'}`
            : 'No está fuerte: no abre',
      rows: [
        {
          label: 'Lectura',
          value:
            r.master === null
              ? 'sin dato'
              : `${masterGlyph(r.master)} (${r.master > 0 ? '+' : ''}${r.master})`,
        },
        ...(r.score === null
          ? []
          : [{ label: 'Puntaje', value: comma(r.score) }]),
      ],
      meter: null,
      history: [],
      rule: 'Solo abre si el maestro está fuerte (▲▲ o ▼▼).',
    },
    {
      id: 'gate',
      icon: 'gate',
      label: 'Portero',
      tone: gateTone,
      headline:
        gateTone === 'na'
          ? 'Sin voto'
          : gateTone === 'ok'
            ? 'Deja pasar la entrada'
            : 'Frena la entrada',
      rows: [
        ...(r.gateSide === null
          ? []
          : [
              {
                label: 'Dice',
                value:
                  r.gateSide > 0 ? 'largo' : r.gateSide < 0 ? 'corto' : 'nada',
              },
            ]),
        {
          label: 'Maestro',
          value: r.master === null ? 'sin dato' : masterGlyph(r.master),
        },
      ],
      meter:
        r.gateP === null
          ? null
          : {
              value: Math.min(1, Math.max(0, r.gateP)),
              mark: 0.5,
              caption: 'Apoyo del portero',
            },
      history: [],
      rule: 'Tiene que coincidir con el lado del maestro. Las noticias pueden pasar por encima.',
    },
    {
      id: 'news',
      icon: 'news',
      label: 'Noticias',
      tone: newsTone,
      word:
        r.news === true || r.newsStatus === 'conflict'
          ? undefined
          : r.newsStatus === 'unavailable'
            ? 'sin dato'
            : 'sin señal',
      headline:
        r.news === true
          ? 'Hay catalizador a favor'
          : r.newsStatus === 'conflict'
            ? 'Contradictorias: sin entrada nueva'
            : r.newsStatus === 'unavailable'
              ? 'Sin dato de noticias'
              : 'Sin catalizador habilitado',
      rows: [
        {
          label: 'Estado',
          value:
            r.news === true
              ? 'a favor'
              : r.newsStatus === 'conflict'
                ? 'contradictorias'
                : r.newsStatus === 'unavailable'
                  ? 'sin dato'
                  : 'sin catalizador',
        },
      ],
      meter: null,
      history: [],
      rule: 'Una noticia verificada puede abrir aunque el portero diga que no.',
    },
    {
      id: 'enter',
      icon: 'enter',
      label: 'Entrada',
      tone: entered ? 'ok' : 'na',
      word: entered ? undefined : 'en espera',
      headline: entered ? view.label : 'Espera: no hay entrada',
      rows: [
        ...(r.motivo ? [{ label: 'Motivo', value: r.motivo }] : []),
        { label: 'Cómo entra', value: 'a mercado, saldo disponible' },
      ],
      meter: null,
      history: [],
      rule: 'Entra a mercado con la cuenta entera cuando todo lo anterior da el sí.',
    },
  ]
}

/** The open trade's exit rules as of one look. */
function exitStepsOf(
  analysis: Record<string, unknown>,
  trade: QwenTrade,
  atMs: number,
  newsEntry: boolean,
): LifecycleStep[] {
  const r = read(analysis)
  const side = trade.side === 'LONG' ? 1 : -1
  const held = Math.max(0, atMs - trade.entryMs)
  const heldH = held / HOUR_MS
  const turned = r.master !== null && side * r.master <= -1
  const weak = r.master !== null && side * r.master < 2
  const exhausted =
    heldH >= EXHAUST_H && r.score !== null && side * r.score <= 0
  const plan = trade.execution?.exitPlan ?? null
  const newsApplies = newsEntry && heldH <= NEWS_H
  const emergency = plan?.outcome?.startsWith('mercado:emergencia') === true
  return [
    {
      id: 'flip',
      icon: 'flip',
      label: 'Maestro gira',
      tone: r.master === null ? 'na' : turned ? 'no' : 'ok',
      headline:
        r.master === null
          ? 'Sin lectura'
          : turned
            ? 'Se dio vuelta en contra: cierra'
            : 'Sigue sin darse vuelta',
      rows: [
        {
          label: 'Maestro ahora',
          value: r.master === null ? 'sin dato' : masterGlyph(r.master),
        },
        { label: 'Posición', value: trade.side === 'LONG' ? 'largo' : 'corto' },
      ],
      meter: null,
      history: [],
      rule: 'Cierra cuando el maestro se da vuelta en contra, al menos flojo.',
    },
    {
      id: 'news12',
      icon: 'clock12',
      label: 'Noticia 12 h',
      tone: !newsApplies ? 'na' : weak ? 'no' : 'ok',
      headline: !newsEntry
        ? 'No aplica: no entró por noticia'
        : heldH > NEWS_H
          ? 'Ya pasaron las 12 h: no rige'
          : weak
            ? 'El maestro ya no está fuerte: cierra'
            : 'El maestro sigue fuerte',
      rows: [
        { label: 'Lleva', value: hours(held) },
        {
          label: 'Rige',
          value: newsEntry
            ? `primeras ${NEWS_H} h`
            : 'solo si entró por noticia',
        },
      ],
      meter: newsEntry
        ? {
            value: Math.min(1, heldH / NEWS_H),
            mark: null,
            caption: 'De las primeras 12 h',
          }
        : null,
      history: [],
      rule: 'Si entró por noticia, en las primeras 12 h cierra cuando el maestro deja de estar fuerte.',
    },
    {
      id: 'exhaust24',
      icon: 'clock24',
      label: '24 h sin fuerza',
      tone: heldH < EXHAUST_H ? 'na' : exhausted ? 'no' : 'ok',
      headline:
        heldH < EXHAUST_H
          ? `Rige en ${hours((EXHAUST_H - heldH) * HOUR_MS)}`
          : exhausted
            ? 'El maestro ya no está a favor: cierra'
            : 'El maestro sigue a favor',
      rows: [
        { label: 'Lleva', value: hours(held) },
        {
          label: 'Puntaje a favor',
          value: r.score === null ? 'sin dato' : comma(side * r.score),
        },
      ],
      meter: {
        value: Math.min(1, heldH / EXHAUST_H),
        mark: null,
        caption: 'De las 24 h',
      },
      history: [],
      rule: 'Pasadas 24 h, cierra si el maestro dejó de estar a favor.',
    },
    {
      id: 'cap',
      icon: 'cap',
      label: 'Tope 36 h',
      tone: heldH >= CAP_H ? 'warn' : 'ok',
      headline:
        heldH >= CAP_H
          ? 'Llegó al tope: cierra'
          : `Faltan ${hours((CAP_H - heldH) * HOUR_MS)}`,
      rows: [
        { label: 'Lleva', value: hours(held) },
        { label: 'Tope', value: `${CAP_H} h` },
      ],
      meter: {
        value: Math.min(1, heldH / CAP_H),
        mark: null,
        caption: 'Del tope de 36 h',
      },
      history: [],
      rule: 'Cierra siempre a las 36 h, pase lo que pase.',
    },
    {
      id: 'maker',
      icon: 'maker',
      label: 'Salida maker',
      tone: !plan
        ? 'na'
        : plan.outcome === null
          ? 'info'
          : plan.outcome === 'maker'
            ? 'ok'
            : 'warn',
      headline: !plan
        ? 'Sin orden: ninguna regla manda cerrar'
        : plan.outcome === null
          ? 'Orden esperando al mejor precio'
          : plan.outcome === 'maker'
            ? 'Salió como maker'
            : 'Salió a mercado',
      rows: plan
        ? [
            {
              label: 'Orden',
              value:
                plan.mode === 'sigue' ? 'sigue al mejor precio' : 'precio fijo',
            },
            {
              label: 'Movida',
              value: `${plan.reprices} ${plan.reprices === 1 ? 'vez' : 'veces'}`,
            },
            ...(plan.outcome?.startsWith('mercado:')
              ? [
                  {
                    label: 'Motivo',
                    value: plan.outcome.replace('mercado:', ''),
                  },
                ]
              : []),
          ]
        : [{ label: 'Estado', value: 'sin orden' }],
      meter: plan
        ? {
            value: Math.min(
              1,
              ((plan.endedMs ?? atMs) - plan.startedMs) / plan.ttlMs,
            ),
            mark: null,
            caption: `A mercado a los ${Math.round(plan.ttlMs / 60_000)} min o a ${plan.topeBp} pb en contra`,
          }
        : null,
      history: [],
      rule: 'Al cerrar deja una orden límite que sigue al mejor precio; sale a mercado a los 45 min, a 40 pb en contra o ante una emergencia.',
    },
    {
      id: 'emergency',
      icon: 'alert',
      label: 'Emergencia',
      tone: emergency ? 'warn' : 'na',
      headline: emergency
        ? 'Salió a mercado por una emergencia'
        : 'Sin emergencia',
      rows: [{ label: 'Cubre', value: 'stop o noticia fuerte' }],
      meter: null,
      history: [],
      rule: 'Una emergencia manda cerrar a mercado sin esperar la orden.',
    },
  ]
}

function qwenLooks(analyses: readonly unknown[]): Record<string, unknown>[] {
  return analyses
    .map(record)
    .filter(
      (analysis) =>
        (typeof analysis.formula_action === 'string' ||
          analysis.qwen_skipped === true) &&
        typeof analysis.decision_time_ms === 'number',
    )
}

/** Did the open trade enter through the news (maestro fuerte, portero no, noticia a favor)? */
function enteredByNews(
  looks: readonly Record<string, unknown>[],
  trade: QwenTrade,
): boolean {
  let best: Record<string, unknown> | null = null
  for (const look of looks) {
    const at = Number(look.decision_time_ms)
    if (
      (look.formula_action === 'LARGO' || look.formula_action === 'CORTO') &&
      Math.abs(at - trade.entryMs) <= 20 * 60_000 &&
      (best === null ||
        Math.abs(at - trade.entryMs) <
          Math.abs(Number(best.decision_time_ms) - trade.entryMs))
    )
      best = look
  }
  if (!best) return false
  const r = read(best)
  return r.news === true && r.gate !== true && r.gateSide === null
}

/**
 * The strip for the product: entry steps when no operation is open, exit steps
 * while one is. `null` when Qwen has not looked yet (nothing to evaluate).
 */
export function lifecycleView(input: {
  analyses: readonly unknown[]
  openTrade: QwenTrade | null
  nowMs: number
}): LifecycleView | null {
  const looks = qwenLooks(input.analyses)
  const latest = looks.at(-1)
  if (!latest) return null
  const evaluatedMs = Number(latest.decision_time_ms)
  const recent = looks.slice(-HISTORY)
  const trade = input.openTrade
  if (trade) {
    const byNews = enteredByNews(looks, trade)
    const build = (analysis: Record<string, unknown>, at: number) =>
      exitStepsOf(analysis, trade, at, byNews)
    // The resting order and the emergency exist only now: no past looks.
    const nowOnly = new Set(['maker', 'emergency'])
    const steps = build(latest, input.nowMs).map((step, index) => ({
      ...step,
      history: nowOnly.has(step.id)
        ? []
        : recent.map(
            (look) =>
              build(look, Number(look.decision_time_ms))[index]?.tone ?? 'na',
          ),
    }))
    return { phase: 'exit', steps, evaluatedMs }
  }
  const steps = entryStepsOf(latest).map((step, index) => ({
    ...step,
    history: recent.map((look) => entryStepsOf(look)[index]?.tone ?? 'na'),
  }))
  return { phase: 'entry', steps, evaluatedMs }
}
