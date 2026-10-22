import { amount } from '../../../shared/finance/format.ts'
import { signedAmount } from './strategy-format.ts'
import type { RunSummary } from '../infrastructure/run-visual-api.ts'

/** What a verdict says about where a test fell short, in plain words. */

const bp = (value: number | null | undefined) => {
  const text = signedAmount(value ?? null, 1)
  return text === null ? 'sin dato' : `${text} pb`
}

const pct = (value: number | null | undefined, digits = 0) =>
  value == null ? 'sin dato' : `${amount(value, digits)} %`

type Rule = NonNullable<RunSummary['rules']>[number]

const share = (value: unknown) => {
  const { positive, total } = (value ?? {}) as {
    positive?: number
    total?: number
  }
  return `${positive ?? 0} de ${total ?? 0}`
}

/** One sentence per failed rule: what it asked and what the test got. */
export function ruleFailure(rule: Rule): string {
  const value = rule.value
  const threshold = typeof rule.threshold === 'number' ? rule.threshold : null
  switch (rule.id) {
    case 'n_trades':
      return `Pocas operaciones: hizo ${value ?? 0} y se piden al menos ${threshold}.`
    case 'mean_net_positive': {
      const { mean, ci_low } = (value ?? {}) as {
        mean?: number | null
        ci_low?: number | null
      }
      return mean != null && mean <= 0
        ? `Perdió en promedio ${bp(mean)} por operación, después de costos.`
        : `Ganó ${bp(mean)} por operación, pero con tan pocas pruebas que el piso de confianza queda en ${bp(ci_low)}: puede ser suerte.`
    }
    case 'percentile_random':
      return `No le ganó al azar: superó al ${pct(value as number | null)} de las entradas sorteadas y se pide al menos ${pct(threshold)}.`
    case 'deflated_sharpe':
      return `Probabilidad de que el resultado no sea suerte: ${pct(value == null ? null : (value as number) * 100)} (se pide ${pct(threshold == null ? null : threshold * 100)}).`
    case 'positive_folds':
      return `Ganó solo en ${share(value)} periodos de tiempo (se pide ${pct(threshold == null ? null : threshold * 100)}).`
    case 'positive_products':
      return `Ganó solo en ${share(value)} productos (se pide ${pct(threshold == null ? null : threshold * 100)}).`
    case 'cost_stress':
      return `Con costos más altos promedia ${bp(value as number | null)} por operación: no aguanta.`
    case 'funding_complete':
      return `Solo ${pct(value == null ? null : (value as number) * 100)} de las operaciones tiene el funding conocido (se pide ${pct(threshold == null ? null : threshold * 100)}).`
    default:
      return `No cumplió: ${rule.label}.`
  }
}

/** Rules of runs saved before the rule list existed are rebuilt from the figures they did save. */
function fromFigures(summary: RunSummary): string[] {
  const out: string[] = []
  if (summary.trades < summary.min_trades)
    out.push(
      `Pocas operaciones: hizo ${summary.trades} y se piden al menos ${summary.min_trades}.`,
    )
  const [low] = summary.ci
  if (summary.mean_bp != null && (summary.mean_bp <= 0 || (low ?? 0) <= 0))
    out.push(
      summary.mean_bp <= 0
        ? `Perdió en promedio ${bp(summary.mean_bp)} por operación, después de costos.`
        : `Ganó ${bp(summary.mean_bp)} por operación, pero el piso de confianza queda en ${bp(low)}: puede ser suerte.`,
    )
  if (summary.percentile != null && summary.percentile < summary.min_percentile)
    out.push(
      `No le ganó al azar: superó al ${pct(summary.percentile)} de las entradas sorteadas y se pide al menos ${pct(summary.min_percentile)}.`,
    )
  if (
    summary.folds > 0 &&
    summary.positive_folds < summary.min_positive_fold_share * summary.folds
  )
    out.push(
      `Ganó solo en ${summary.positive_folds} de ${summary.folds} periodos de tiempo.`,
    )
  return out
}

const INCONCLUSIVE: Record<string, string> = {
  few_trades: 'Hay muy pocas operaciones para decidir.',
  funding:
    'Falta el funding de muchas operaciones, y sin él el resultado es optimista.',
  contaminated:
    'La reserva ya la usó esta familia de estrategias: el examen no cuenta como evidencia independiente.',
}

/** Why the verdict is not PASA; empty for PASA. */
export function failureReasons(summary: RunSummary): string[] {
  if (summary.verdict === 'PASA') return []
  const reasons: string[] = []
  if (summary.verdict === 'INCONCLUSO')
    for (const code of summary.inconclusive_reasons)
      reasons.push(INCONCLUSIVE[code] ?? code)
  else {
    const failed = (summary.rules ?? []).filter((rule) => !rule.ok)
    reasons.push(
      ...(summary.rules ? failed.map(ruleFailure) : fromFigures(summary)),
    )
    if (summary.contaminated) reasons.push(INCONCLUSIVE.contaminated)
  }
  return reasons
}
