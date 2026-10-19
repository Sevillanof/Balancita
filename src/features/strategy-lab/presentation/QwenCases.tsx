import { percent } from '../../../shared/finance/format.ts'
import {
  agoText,
  Q_ERROR_LABELS,
  Q_MODEL_STATE_LABELS,
  Q_OPTION_LABELS,
  Q_SKIP_LABELS,
} from '../domain/forward-text.ts'
import type {
  QCase,
  QCases,
  QDecisionCase,
  QModelState,
} from '../infrastructure/strategy-api.ts'

const optionLabel = (option: string) => Q_OPTION_LABELS[option] ?? option

function Decision({ item, now }: { item: QDecisionCase; now: number }) {
  return (
    <li data-testid="q-case-decision" className="comparison__qcase">
      <div>
        <b>{item.product_id}</b> · Decide: <b>{optionLabel(item.chosen)}</b> ·
        Confianza {percent(item.confidence * 100)}
        <small> · {agoText(item.written_at, now)}</small>
      </div>
      <ul data-testid="q-case-probabilities" className="comparison__qprobs">
        {Object.entries(item.probabilities).map(([option, probability]) => (
          <li key={option}>
            <span
              role="meter"
              aria-label={optionLabel(option)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(probability * 100)}
              className={`comparison__qbar${option === item.chosen ? ' is-chosen' : ''}`}
              style={{ ['--q-share' as string]: `${probability * 100}%` }}
            />
            <span>{`${optionLabel(option)} ${percent(probability * 100)}`}</span>
          </li>
        ))}
      </ul>
      <small>
        {item.question_id}@{item.question_version} · prompt v
        {item.prompt_version} · fuente {item.probability_source} ·{' '}
        {item.latency_ms} ms · {item.model_ref}
      </small>
    </li>
  )
}

function NoDecision({
  item,
  now,
}: {
  item: Exclude<QCase, QDecisionCase>
  now: number
}) {
  const labels = item.kind === 'error' ? Q_ERROR_LABELS : Q_SKIP_LABELS
  return (
    <li data-testid="q-case-none" className="comparison__qcase">
      <div>
        <b>{item.product_id}</b> · Sin decisión:{' '}
        <b>{labels[item.code] ?? item.code}</b>
        <small> · {agoText(item.written_at, now)}</small>
      </div>
      <small>
        {item.reason} · {item.question_id}@{item.question_version}
      </small>
    </li>
  )
}

function ModelState({ state }: { state: QModelState }) {
  return (
    <p className="is-down" data-testid="q-model-state" role="status">
      <b>{Q_MODEL_STATE_LABELS[state.code] ?? state.code}:</b> {state.reason}
      {state.code === 'not_started' &&
        '. Los saltos de abajo son anteriores a este arranque.'}
    </p>
  )
}

/** What Q decided in each recent case, or why it did not: read-only, no controls. */
export function QwenCases({
  cases,
  now,
}: {
  cases: QCases | null | undefined
  now: number
}) {
  const body =
    cases === null ? (
      <p>El servicio no tiene configurada la lectura de las decisiones de Q.</p>
    ) : cases === undefined ? (
      <p>
        El servicio no devuelve las decisiones de Q: reinícialo para que use
        esta versión.
      </p>
    ) : (
      <>
        {cases.model && <ModelState state={cases.model} />}
        {!cases.available ? (
          <p>{cases.reason}</p>
        ) : cases.latest.length === 0 ? (
          <p>Q no ha decidido ni saltado ningún caso.</p>
        ) : (
          <ul className="comparison__qcases">
            {cases.latest.map((item, index) =>
              item.kind === 'decision' ? (
                <Decision
                  key={`${item.written_at}-${index}`}
                  item={item}
                  now={now}
                />
              ) : (
                <NoDecision
                  key={`${item.written_at}-${index}`}
                  item={item}
                  now={now}
                />
              ),
            )}
          </ul>
        )}
      </>
    )
  return (
    <article className="comparison__panel" data-testid="q-cases">
      <h3>
        Qué decide Qwen <small>últimos casos, solo lectura</small>
      </h3>
      {body}
    </article>
  )
}
