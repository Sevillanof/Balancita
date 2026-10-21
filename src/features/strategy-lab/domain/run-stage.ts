import type { GateOverview } from '../infrastructure/gate-api.ts'

/** Research phases, in order. They are not the registry's draft/shadow/active/retired states. */
export const STAGES = [
  'Hipótesis',
  'Optimizar',
  'Validar',
  'Examen',
  'Paper',
] as const
export type StageName = (typeof STAGES)[number]

export type StageInfo = {
  /** Index in `STAGES` of the furthest phase the evidence reaches. */
  index: number
  name: StageName
  /** One line saying what evidence put it there. */
  reason: string
}

/**
 * The phase of THIS version, derived only from the gate's own records:
 * - Paper: its exam finished with PASA (an explicit activation is still needed).
 * - Examen: the exam was taken or is running (a NO PASA stays here; it is not "Paper").
 * - Validar: a finished practice of this exact content said PASA.
 * - Optimizar: at least one practice of this content was run.
 * - Hipótesis: nothing tested yet.
 */
export function deriveStage(overview: GateOverview | null): StageInfo {
  const none: StageInfo = {
    index: 0,
    name: 'Hipótesis',
    reason: 'Todavía no tiene pruebas.',
  }
  if (!overview) return none
  const { exam, runs } = overview
  if (exam.taken && exam.same_version) {
    if (exam.status === 'done' && exam.verdict === 'PASA')
      return {
        index: 4,
        name: 'Paper',
        reason: 'Pasó el examen final. Activarla sigue siendo decisión tuya.',
      }
    return {
      index: 3,
      name: 'Examen',
      reason:
        exam.status === 'running'
          ? 'El examen final está en curso.'
          : `Examen final rendido: ${exam.verdict ?? 'sin veredicto'}.`,
    }
  }
  const mine = runs.filter((run) => run.same_version !== false)
  const practice = mine.filter(
    (run) => run.kind === 'practice' && run.status === 'done',
  )
  if (practice.some((run) => run.verdict === 'PASA'))
    return {
      index: 2,
      name: 'Validar',
      reason: 'Una práctica de esta versión pasó.',
    }
  if (practice.length > 0 || mine.some((run) => run.kind === 'practice'))
    return {
      index: 1,
      name: 'Optimizar',
      reason: `${practice.length} ${practice.length === 1 ? 'práctica terminada' : 'prácticas terminadas'}.`,
    }
  return none
}
