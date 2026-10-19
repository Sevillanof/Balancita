import { useState } from 'react'
import { StatusPill } from '../../../shared/mission-control/index.ts'
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

/** One compact panel: funding per product and the forward cycle, plus what Qwen last decided. */
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
  const products = Object.entries(health.funding)
  return (
    <article className="comparison__panel" data-testid="forward-health">
      <h3>
        Forward y Qwen{' '}
        <small>
          ciclo del forward cada {Math.round(health.cadence_s / 60)} min
        </small>
      </h3>
      {products.length === 0 ? (
        <p>
          {health.summary_available
            ? 'El resumen no trae estado de funding.'
            : 'Sin resumen del forward: no se puede leer el funding.'}
        </p>
      ) : (
        <ul data-testid="funding-list" className="comparison__funding">
          {products.map(([product, state]) => (
            <li key={product}>
              <StatusPill tone={state.usable ? 'ok' : 'warn'}>
                {state.usable ? 'Funding usable' : 'Funding no usable'}
              </StatusPill>{' '}
              {product}
              {!state.usable && `: ${state.reason}`}
              <small> · {agoText(state.checked_ms, now)}</small>
            </li>
          ))}
        </ul>
      )}
      <Qwen health={health} now={now} />
    </article>
  )
}
