import { RUN } from './run-view-styles.ts'
import { etaText } from '../domain/vectorbt-format.ts'
import type { VbtExploration } from '../infrastructure/vectorbt-api.ts'
import RunProgress from './RunProgress.tsx'

/** Phases in which the first run of a session spends more time. */
const SLOW_FIRST_TIME = ['Descargando datos', 'Preparando el simulador']

type Props = {
  exploration: VbtExploration
  cancelling: boolean
  onCancel: () => void
}

/** Bar of the exploration under the stages: real fill, phase and detail, time left and Cancelar. */
export default function VectorbtProgress({
  exploration,
  cancelling,
  onCancel,
}: Props) {
  const percent = Math.min(Math.max(exploration.progress, 0), 100)
  const eta = etaText(exploration.eta)
  const what = exploration.detail
    ? `${exploration.phase} · ${exploration.detail}`
    : exploration.phase
  return (
    <RunProgress
      label="Progreso de la exploración con VectorBT"
      percent={percent}
      valueText={`${Math.round(percent)} %: ${what}`}
    >
      <p className={RUN.progressText} data-testid="vbt-progress-text">
        <span>
          Explorando con VectorBT · {Math.round(percent)} % · {what}
          {eta && ` · faltan ${eta}`}
        </span>
        <button type="button" onClick={onCancel} disabled={cancelling}>
          {cancelling ? 'Cancelando…' : 'Cancelar'}
        </button>
      </p>
      {SLOW_FIRST_TIME.includes(exploration.phase) && (
        <p className={RUN.hint}>
          La primera vez tarda más: baja datos de Kraken y prepara el simulador.
          Las siguientes son bastante más rápidas.
        </p>
      )}
    </RunProgress>
  )
}
