import { useState } from 'react'
import { percent } from '../../../shared/finance/format.ts'
import {
  agoText,
  Q_ERROR_LABELS,
  Q_OPTION_LABELS,
  Q_SKIP_LABELS,
} from '../domain/forward-text.ts'
import type {
  QCase,
  QDecisionCase,
  QNoDecisionCase,
  ForwardHealth as Health,
} from '../infrastructure/strategy-api.ts'

const optionLabel = (option: string) => Q_OPTION_LABELS[option] ?? option

function noDecisionWhy(item: QNoDecisionCase) {
  const labels = item.kind === 'error' ? Q_ERROR_LABELS : Q_SKIP_LABELS
  return labels[item.code] ?? item.code
}

/** `Comprar 60 % · Mantener 30 % · Vender 10 %`. */
function optionsText(item: QDecisionCase) {
  return Object.entries(item.probabilities)
    .map(([option, p]) => `${optionLabel(option)} ${percent(p * 100)}`)
    .join(' · ')
}

/** `lee el prompt 591 ms · responde 0 ms`: where the time went, when llama-server reported it. */
function timeSplit(item: QDecisionCase) {
  const parts = [
    item.prompt_ms == null
      ? null
      : `lee el prompt ${Math.round(item.prompt_ms)} ms`,
    item.predicted_ms == null
      ? null
      : `responde ${Math.round(item.predicted_ms)} ms`,
  ].filter(Boolean)
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
}

function DecisionLines({
  item,
  now,
  detail,
}: {
  item: QDecisionCase
  now: number
  detail?: boolean
}) {
  return (
    <>
      <div>
        <b>{item.product_id}</b> · Qwen decide:{' '}
        <b>{optionLabel(item.chosen)}</b> · confianza{' '}
        {percent(item.confidence * 100)}
        <small> · {agoText(item.written_at, now)}</small>
      </div>
      <small>{optionsText(item)}</small>
      <small>
        {item.question_id} v{item.question_version} · {item.latency_ms} ms
        {detail &&
          ` · prompt v${item.prompt_version} · probabilidades ${item.probability_source} · ${item.model_ref}`}
        {detail && timeSplit(item)}
      </small>
    </>
  )
}

function NoDecisionLine({
  item,
  now,
  detail,
}: {
  item: QNoDecisionCase
  now: number
  detail?: boolean
}) {
  return (
    <>
      <div>
        <b>{item.product_id}</b> · Qwen no decidió: {noDecisionWhy(item)}
        <small> · {agoText(item.written_at, now)}</small>
      </div>
      {detail && <small>{item.reason}</small>}
    </>
  )
}

function Case({
  item,
  now,
  detail,
}: {
  item: QCase
  now: number
  detail?: boolean
}) {
  return item.kind === 'decision' ? (
    <DecisionLines item={item} now={now} detail={detail} />
  ) : (
    <NoDecisionLine item={item} now={now} detail={detail} />
  )
}

/** The latest thing Qwen did (or why nothing), and a button for the earlier ones. */
function Qwen({ health, now }: { health: Health; now: number }) {
  const [open, setOpen] = useState(false)
  const cases = health.q_cases
  if (cases === undefined)
    return (
      <p data-testid="q-latest">
        Qwen: este servicio aún no devuelve sus decisiones; reinícialo.
      </p>
    )
  const model = cases.model
  const [first, ...rest] = cases.latest
  // With the model not running, the reason is the headline; a stored skip would only repeat it.
  const showFirst = first !== undefined && !(model && first.kind !== 'decision')
  const history = showFirst ? rest : cases.latest
  return (
    <div className="comparison__qwen" data-testid="q-latest">
      {model && (
        <div className="is-down" data-testid="q-model-state" role="status">
          Qwen no decidió: {model.reason}
        </div>
      )}
      {!cases.available ? (
        !model && <div>Qwen: {cases.reason}</div>
      ) : showFirst ? (
        <Case item={first} now={now} />
      ) : (
        !model && <div>Qwen todavía no ha decidido ningún caso.</div>
      )}
      {cases.available && (
        <>
          <button
            type="button"
            className="comparison__qbutton"
            aria-expanded={open}
            aria-controls="q-history"
            onClick={() => setOpen(!open)}
          >
            Históricos de Qwen
          </button>
          {open && (
            <ul
              id="q-history"
              data-testid="q-history"
              className="comparison__qhistory"
            >
              {history.length === 0 ? (
                <li>Aún no hay decisiones anteriores.</li>
              ) : (
                history.map((item, index) => (
                  <li key={`${item.written_at}-${index}`}>
                    <Case item={item} now={now} detail />
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** One compact panel: what Qwen last decided, and the earlier cases behind a button. The funding lives in the header. */
export function ForwardHealth({
  health,
  now,
}: {
  health: Health | null
  now: number
}) {
  if (health === null)
    return (
      <p className="comparison__health-off" data-testid="forward-health">
        <b>Salud del forward:</b> el servicio no tiene configurada la lectura
        del forward.
      </p>
    )
  return (
    <article className="comparison__panel" data-testid="forward-health">
      <h3>Qwen</h3>
      <Qwen health={health} now={now} />
    </article>
  )
}
