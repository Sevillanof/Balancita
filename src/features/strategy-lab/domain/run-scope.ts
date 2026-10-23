import type { GateRun } from '../infrastructure/gate-api.ts'

/**
 * Plain-language scope of one gate run: what the test measured, whether its net
 * result is definitive, how stable it was over time and whether its evidence can
 * be audited. Old runs lack these fields and get a neutral note, never a claim
 * of full validation.
 */
export type RunScopeLine = {
  key: 'scope' | 'funding' | 'temporal' | 'audit'
  text: string
  /** `warn` marks a limit the reader should not skip. */
  tone: 'warn' | null
}

export const OLD_RUN_SCOPE = 'Prueba anterior: sin datos de alcance'

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const percent = (share: number) =>
  `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(share * 100)} %`

const usd = (value: number) =>
  `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(value)} USD`

function scopeLine(run: GateRun): RunScopeLine {
  const policy = run.evaluation_policy
  if (policy?.classification === 'baseline_only') {
    const notional = policy.notional_per_trade_usd
    const book =
      notional !== null && notional !== undefined && notional !== ''
        ? `libro fijo de ${notional} USD por operación`
        : 'libro fijo por operación'
    return {
      key: 'scope',
      text: `Prueba base: ${book}; no repite las decisiones de Qwen. Un PASA acá no valida la política completa.`,
      tone: 'warn',
    }
  }
  if (policy?.reasons?.includes('recorded_model_trades_not_policy_replay'))
    return {
      key: 'scope',
      text: 'Usa las operaciones ya registradas del modelo; no repite sus decisiones ni valida la política completa.',
      tone: 'warn',
    }
  return { key: 'scope', text: OLD_RUN_SCOPE, tone: null }
}

function fundingLine(run: GateRun, hasScope: boolean): RunScopeLine | null {
  const acc = run.accounting
  const state = acc?.state
  if (!acc || !state || state === 'unclassified') {
    return hasScope
      ? {
          key: 'funding',
          text: 'Resultado: sin datos de funding; no se puede decir si el neto es definitivo.',
          tone: 'warn',
        }
      : null
  }
  const parts: string[] = []
  if (state === 'complete') {
    parts.push(
      isNumber(acc.definitive_net_usd)
        ? `Resultado definitivo: ${usd(acc.definitive_net_usd)}.`
        : 'Resultado definitivo.',
    )
  } else if (state === 'provisional') {
    parts.push(
      `Resultado provisional${isNumber(acc.observed_net_usd) ? ` (${usd(acc.observed_net_usd)} observado)` : ''}: falta funding o costes completos, así que todavía no es el neto definitivo.`,
    )
  } else if (state === 'no_trades') {
    parts.push('Sin operaciones cerradas: no hay resultado que medir.')
  } else if (state === 'censored') {
    parts.push(
      'Hay posiciones abiertas al cierre de la prueba: el resultado no es definitivo.',
    )
  } else {
    parts.push('Resultado sin clasificar.')
  }
  if (isNumber(acc.funding_complete_share)) {
    const min = isNumber(acc.minimum_complete_share)
      ? ` (mínimo ${percent(acc.minimum_complete_share)})`
      : ''
    const verdict =
      acc.funding_eligible === true
        ? 'cumple el mínimo'
        : acc.funding_eligible === false
          ? 'no llega al mínimo'
          : ''
    parts.push(
      `Funding completo en ${percent(acc.funding_complete_share)} de las operaciones${min}${verdict ? `: ${verdict}` : ''}.`,
    )
  }
  const partial =
    state !== 'complete' ||
    acc.funding_eligible === false ||
    (isNumber(acc.funding_complete_share) && acc.funding_complete_share < 1)
  return {
    key: 'funding',
    text: parts.join(' '),
    tone: partial && state !== 'no_trades' ? 'warn' : null,
  }
}

function temporalLine(run: GateRun, hasScope: boolean): RunScopeLine | null {
  const t = run.temporal
  const state = t?.state
  if (!t || !state || state === 'unknown') {
    return hasScope
      ? {
          key: 'temporal',
          text: 'Estabilidad por períodos: sin datos.',
          tone: null,
        }
      : null
  }
  const note =
    ' No es una prueba de entrenamiento y validación: solo mira si el resultado se sostiene en cada período.'
  switch (state) {
    case 'observed': {
      const out = isNumber(t.excluded_trades) && t.excluded_trades > 0
      return {
        key: 'temporal',
        text: `Estabilidad por períodos medida${out ? `; ${t.excluded_trades} operaciones quedaron fuera por cruzar períodos o por el margen entre ellos` : ''}.${note}`,
        tone: null,
      }
    }
    case 'insufficient':
      return {
        key: 'temporal',
        text: `Estabilidad por períodos con pocos datos: hay períodos vacíos o con una sola operación.${note}`,
        tone: 'warn',
      }
    case 'unsupported':
      return {
        key: 'temporal',
        text: 'Estabilidad por períodos no evaluable para este tipo de prueba. Es una limitación, no un fallo medido: sin esa evidencia no se puede dar PASA.',
        tone: 'warn',
      }
    case 'no_trades':
      return {
        key: 'temporal',
        text: 'Estabilidad por períodos: sin operaciones para medir.',
        tone: null,
      }
    case 'censored':
      return {
        key: 'temporal',
        text: 'Estabilidad por períodos incompleta: hay posiciones abiertas al cierre.',
        tone: 'warn',
      }
    default:
      return {
        key: 'temporal',
        text: 'Estabilidad por períodos: sin datos.',
        tone: null,
      }
  }
}

function auditLine(run: GateRun): RunScopeLine | null {
  const audit = run.audit
  const state = audit?.state
  if (!audit || !state || state === 'unknown') return null
  if (state === 'available')
    return {
      key: 'audit',
      text: 'Auditoría: los datos y las decisiones de esta prueba se pueden revisar. No la verificó un tercero.',
      tone: null,
    }
  if (state === 'partial')
    return {
      key: 'audit',
      text: 'Auditoría parcial: falta parte del registro de datos o decisiones.',
      tone: 'warn',
    }
  if (state === 'pending')
    return {
      key: 'audit',
      text: 'Auditoría: se completa al terminar la prueba.',
      tone: null,
    }
  return {
    key: 'audit',
    text: 'Auditoría no disponible para esta prueba.',
    tone: 'warn',
  }
}

export function runScopeLines(run: GateRun): RunScopeLine[] {
  const scope = scopeLine(run)
  const hasScope = scope.text !== OLD_RUN_SCOPE
  return [
    scope,
    fundingLine(run, hasScope),
    temporalLine(run, hasScope),
    auditLine(run),
  ].filter((line): line is RunScopeLine => line !== null)
}
