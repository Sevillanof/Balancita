import { record } from '../shared/wire/decode.ts'
import {
  analysisAction,
  reasonLabel,
  strategyLabel,
} from './terminal-labels.ts'

/** Selected decision strip: strategy, short id with copy, reason, proposals. */
export default function SelectedDecision({
  analysis,
  id,
  time,
  reason,
}: {
  analysis: Record<string, unknown>
  id: string
  time: string
  reason: string
}) {
  const selector = record(analysis.selector)
  const proposals = Array.isArray(analysis.proposals) ? analysis.proposals : []
  return (
    <div
      className="connected-terminal__selected"
      aria-label="Decisión seleccionada"
    >
      <p>
        <strong>{analysisAction(analysis)}</strong> ·{' '}
        {strategyLabel(selector.strategy_id ?? analysis.selected_strategy_id)}
      </p>
      <p>{reason}</p>
      <p>
        <small>{time}</small>
      </p>
      <details>
        <summary>Propuestas, condiciones e ID</summary>
        <p>
          <code className="connected-terminal__hash" title={id}>
            {id ? id.slice(0, 12) : 'ID no disponible'}
          </code>
          <button
            type="button"
            className="demo-terminal__present"
            aria-label={`Copiar ID completo ${id}`}
            onClick={() => void navigator.clipboard?.writeText(id)}
          >
            Copiar ID
          </button>
        </p>

        {proposals.map((proposalValue, proposalIndex) => {
          const proposal = record(proposalValue)
          const conditions = Array.isArray(proposal.conditions)
            ? proposal.conditions
            : []
          return (
            <div key={String(proposal.strategy_id ?? proposalIndex)}>
              <strong>{String(proposal.strategy_id ?? 'Estrategia')}</strong>
              <p>
                {String(proposal.action ?? 'WAIT')} ·{' '}
                {reasonLabel(proposal.reason_code)}
              </p>
              {conditions.map((conditionValue, conditionIndex) => {
                const condition = record(conditionValue)
                return (
                  <small key={String(condition.code ?? conditionIndex)}>
                    {String(condition.code ?? 'Condición')}:{' '}
                    {condition.passed === true
                      ? 'cumplida'
                      : condition.passed === false
                        ? 'no cumplida'
                        : 'no disponible'}
                  </small>
                )
              })}
            </div>
          )
        })}
      </details>
    </div>
  )
}
