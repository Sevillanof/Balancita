import { record } from '../shared/wire/decode.ts'
import {
  DECISION_TONES,
  TERMINAL_BUTTON,
} from '../shared/design-system/terminal-styles.ts'
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
  notes = [],
}: {
  analysis: Record<string, unknown>
  id: string
  time: string
  reason: string
  /** What this decision lacks on the chart or in the list. */
  notes?: string[]
}) {
  const selector = record(analysis.selector)
  const proposals = Array.isArray(analysis.proposals) ? analysis.proposals : []
  return (
    <div aria-label="Decisión seleccionada">
      <p>
        <strong
          className={DECISION_TONES[analysisAction(analysis)]}
          data-action={analysisAction(analysis)}
        >
          {analysisAction(analysis)}
        </strong>{' '}
        · {strategyLabel(selector.strategy_id ?? analysis.selected_strategy_id)}
      </p>
      <p>{reason}</p>
      {typeof analysis.qwen_probabilities === 'string' &&
        analysis.qwen_probabilities.length > 0 && (
          <p>
            <small data-testid="qwen-probabilities">
              Probabilidad de cada opción: {analysis.qwen_probabilities}
            </small>
          </p>
        )}
      {notes.map((note) => (
        <p key={note} role="status" data-testid="decision-limit">
          <small>{note}</small>
        </p>
      ))}
      <p>
        <small>{time}</small>
      </p>
      <details>
        <summary>Propuestas, condiciones e ID</summary>
        <p>
          <code
            className="my-chart-row block min-w-0 max-w-full font-account-mono text-hint leading-normal whitespace-normal wrap-anywhere break-word"
            title={id}
          >
            {id ? id.slice(0, 12) : 'ID no disponible'}
          </code>
          <button
            type="button"
            className={TERMINAL_BUTTON}
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
