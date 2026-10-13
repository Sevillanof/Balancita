import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './observability.css'
import './decisions.css'
import { DataState, StatusPill } from '../../../shared/mission-control/index.ts'
import {
  fetchDecisions,
  fetchTrace,
  type DecisionItem,
  type DecisionTrace,
  type ModelDecisions,
} from '../infrastructure/decisions-api.ts'
import {
  ACTIONS,
  NOT_AVAILABLE,
  SPANS,
  actionLabel,
  conditionSummary,
  isDirectional,
  proposalOwner,
  reasonOrigin,
  rowStrategy,
  scalarText,
  utcClock,
  utcDay,
  utcMinute,
  type SpanId,
} from './decisions-view.ts'

const PAGE_SIZE = 50

type Loaded<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; value: T; at: number }

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'error desconocido'

/**
 * One read per `key`: while the answer is for another key (or none yet) the
 * state is `loading`, so a previous answer is never shown for a new question.
 */
function useKeyed<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
): Loaded<T> {
  const [result, setResult] = useState<{
    key: string
    loaded: Loaded<T>
  } | null>(null)
  useEffect(() => {
    if (key === null) return
    const abort = new AbortController()
    load(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted)
          setResult({
            key,
            loaded: { state: 'ready', value, at: Date.now() },
          })
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setResult({
            key,
            loaded: { state: 'error', message: errorText(cause) },
          })
      })
    return () => abort.abort()
  }, [key, load])
  return result && result.key === key ? result.loaded : { state: 'loading' }
}

function ActionTag({ action }: { action: string }) {
  return (
    <span className="inv-action" data-action={action}>
      {actionLabel(action)}
    </span>
  )
}

function Na({ children }: { children?: string }) {
  return <span className="obs-na">{children ?? NOT_AVAILABLE}</span>
}

type StageTone = 'ok' | 'warn' | 'nodata'
const STAGE_LABEL: Record<StageTone, string> = {
  ok: 'REGISTRADO',
  warn: 'PARCIAL',
  nodata: 'NO DISPONIBLE',
}

function Stage({
  n,
  title,
  tone,
  pill,
  origin,
  children,
}: {
  n: number
  title: string
  tone: StageTone
  /** Replaces the tone's label (e.g. the final action). */
  pill?: React.ReactNode
  origin: string
  children: React.ReactNode
}) {
  return (
    <li className="inv-stage" data-tone={tone} data-testid={`stage-${n}`}>
      <div className="inv-stage__head">
        <h3>
          <span>{n}.</span> {title}
        </h3>
        {pill ?? <StatusPill tone={tone}>{STAGE_LABEL[tone]}</StatusPill>}
      </div>
      <div className="inv-stage__body">{children}</div>
      <p className="inv-stage__origin">Origen: {origin}</p>
    </li>
  )
}

/**
 * The model's stored answers for this product and minute. They are shown
 * because they share the key, not because the selector used them.
 */
function ModelRows({ model }: { model: ModelDecisions }) {
  if (model.state === 'unavailable')
    return (
      <p className="obs-note" data-testid="model-rows">
        Registro del modelo: <Na>No disponible</Na> (
        {model.evidence.origin ?? 'sin configurar'}: {model.detail}).
      </p>
    )
  if (model.items.length === 0)
    return (
      <p className="obs-note" data-testid="model-rows">
        Registro del modelo: <Na>No disponible</Na>. La base de decisiones se
        leyó y no tiene fila para este minuto.
      </p>
    )
  return (
    <div data-testid="model-rows">
      <p className="obs-note">
        Registro del modelo para este producto y minuto (correlación por clave:
        no indica que haya intervenido en la acción):
      </p>
      <ul className="inv-proposals">
        {model.items.map((m) => (
          <li key={`${m.questionId}|${m.questionVersion}`}>
            <div className="inv-proposals__line">
              <code>{m.questionId}</code>
              <b>{m.chosen}</b>
            </div>
            <p className="obs-note">
              {m.modelRef} · confianza{' '}
              {m.confidence === null ? NOT_AVAILABLE : m.confidence}
              {m.probabilities &&
                ` · ${m.probabilities
                  .map(([name, value]) => `${name} ${value}`)
                  .join(' / ')}`}
              {!m.matchesVerdict &&
                ' · escrita contra otro veredicto (hash distinto)'}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Pipeline({
  trace,
}: {
  trace: Extract<DecisionTrace, { state: 'ok' }>
}) {
  const { decision, payload } = trace
  const proposals = payload?.proposals ?? null
  const selected = payload?.selected ?? null
  const chosen = selected?.proposal ?? null
  return (
    <ol className="inv-pipeline" aria-label="Pipeline de decisión">
      <Stage
        n={1}
        title="Mercado"
        tone="warn"
        origin="paper_futures_verdicts · bucket_start, decision_known_at"
      >
        <p>
          Vela de {decision.intervalMs / 60_000} min del bucket{' '}
          <b>{utcMinute(decision.bucketStartMs)}</b>
          {payload?.closeAtMs != null && (
            <> (cierra {utcMinute(payload.closeAtMs)})</>
          )}
          ; el motor conoció la decisión a las{' '}
          <b>{utcClock(decision.decisionKnownAtMs)}</b>
          {payload?.knowledgeLagMs != null && (
            <> · retraso de conocimiento {payload.knowledgeLagMs} ms</>
          )}
          .
        </p>
        <p className="obs-note">Libro y spread al decidir: no se guardan.</p>
      </Stage>

      <Stage
        n={2}
        title="Estrategias"
        tone={proposals ? 'ok' : 'nodata'}
        origin="payload_json.proposals[]"
      >
        {proposals ? (
          proposals.length === 0 ? (
            <p>El payload trae una lista de propuestas vacía.</p>
          ) : (
            <ul className="inv-proposals" data-testid="proposals">
              {proposals.map((p) => {
                const counts = conditionSummary(p.conditions)
                return (
                  <li key={`${p.strategyId}|${p.delegatedStrategyId ?? ''}`}>
                    <div className="inv-proposals__line">
                      <code>{proposalOwner(p)}</code>
                      <ActionTag action={p.action} />
                    </div>
                    <p className="obs-note">
                      Motivo de esta propuesta: <code>{p.reasonCode}</code>
                      {p.conditions.length > 0 && (
                        <>
                          {' '}
                          · condiciones: {counts.passed} cumplidas,{' '}
                          {counts.failed} no cumplidas
                          {counts.unknown > 0 && `, ${counts.unknown} sin dato`}
                        </>
                      )}
                    </p>
                    {p.conditions.length > 0 && (
                      <details className="obs-details obs-details--inline">
                        <summary>Condiciones evaluadas</summary>
                        <table className="inv-conditions">
                          <tbody>
                            {p.conditions.map((c) => (
                              <tr key={c.code} data-passed={String(c.passed)}>
                                <td>
                                  <code>{c.code}</code>
                                </td>
                                <td>
                                  {scalarText(c.value)} {c.operator ?? '?'}{' '}
                                  {scalarText(c.threshold)}
                                </td>
                                <td>
                                  {c.passed === null
                                    ? NOT_AVAILABLE
                                    : c.passed
                                      ? 'cumple'
                                      : 'no cumple'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
          )
        ) : (
          <>
            <p>
              <Na>
                El payload de este veredicto no trae propuestas por estrategia.
              </Na>
            </p>
            <p className="obs-note">
              Motivo registrado en la fila: <code>{decision.reasonCode}</code>{' '}
              (no se atribuye a una estrategia).
            </p>
          </>
        )}
      </Stage>

      <Stage
        n={3}
        title="Selector"
        tone={selected ? 'ok' : 'nodata'}
        origin="payload_json.selected"
      >
        {selected ? (
          <>
            <p>
              Resultado: <ActionTag action={selected.action} /> ·{' '}
              <code>{selected.reasonCode}</code>
            </p>
            <p className="obs-note" data-testid="reason-origin">
              {reasonOrigin(selected.action, selected.strategyId, true)}
            </p>
          </>
        ) : (
          <p>
            <Na>El payload no trae el resultado del selector.</Na>
          </p>
        )}
        <ModelRows model={trace.modelDecisions} />
      </Stage>

      <Stage
        n={4}
        title="Riesgo y costes"
        tone={chosen ? 'warn' : 'nodata'}
        origin="payload_json.selected (propuesta seleccionada)"
      >
        {chosen ? (
          <ul className="inv-kv">
            <li>
              <span>Stop propuesto</span>
              <b>{chosen.proposedStop ?? NOT_AVAILABLE}</b>
            </li>
            <li>
              <span>Objetivo propuesto</span>
              <b>{chosen.proposedTarget ?? NOT_AVAILABLE}</b>
            </li>
            <li>
              <span>Coste ida y vuelta estimado</span>
              <b>
                {chosen.estimatedRoundTripCostBps === null
                  ? NOT_AVAILABLE
                  : `${chosen.estimatedRoundTripCostBps} bps`}
              </b>
            </li>
          </ul>
        ) : (
          <p>
            <Na>
              Sin propuesta seleccionada: no hay stop, objetivo ni coste que
              mostrar.
            </Na>
          </p>
        )}
        <p className="obs-note">
          No existe registro de rechazos del motor de riesgo por veredicto.
        </p>
      </Stage>

      <Stage
        n={5}
        title="Decisión final"
        tone="ok"
        pill={<ActionTag action={decision.action} />}
        origin="paper_futures_verdicts.action, reason_code"
      >
        <p>
          Acción registrada <b>{decision.action}</b> con motivo{' '}
          <code>{decision.reasonCode}</code>.
        </p>
      </Stage>

      <Stage
        n={6}
        title="Ejecución paper"
        tone="nodata"
        origin="forward_trade · enlace con el veredicto (B5)"
      >
        <p>
          <Na>
            No disponible: la operación asociada a este veredicto no está
            enlazada.
          </Na>
        </p>
        <p className="obs-note">
          {isDirectional(decision.action)
            ? 'Una propuesta no es una operación: ningún registro del forward se enlaza a este veredicto.'
            : 'Un veredicto de espera o abstención no abre operación.'}
        </p>
      </Stage>

      <li className="inv-stage inv-stage--post" data-testid="stage-post">
        <div className="inv-stage__head">
          <h3>Evaluación posterior (retrospectiva)</h3>
          <StatusPill tone="nodata">NO DISPONIBLE</StatusPill>
        </div>
        <p className="obs-note">
          Resultado a 15 / 60 / 240 / 1440 min y MFE/MAE: requiere los forecasts
          por veredicto (B3 completo). Se mostrará separada de lo que se sabía
          al decidir.
        </p>
      </li>
    </ol>
  )
}

function exportTrace(trace: DecisionTrace) {
  const blob = new Blob([JSON.stringify(trace, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `veredicto-${trace.product}-${trace.bucketStartMs}.json`
  link.click()
  URL.revokeObjectURL(url)
}

function TraceColumn({ trace }: { trace: Loaded<DecisionTrace> }) {
  return (
    <aside
      className="inv-trace"
      aria-label="Investigación de decisión"
      data-testid="trace-panel"
    >
      <div className="inv-trace__head">
        <p className="inv-label inv-label--accent">
          Investigación de decisión · pipeline de 6 etapas
        </p>
      </div>
      {trace.state === 'loading' && <DataState kind="loading" />}
      {trace.state === 'error' && (
        <DataState
          kind="error"
          title="No se pudo leer la traza"
          detail={trace.message}
        />
      )}
      {trace.state === 'ready' && trace.value.state === 'unavailable' && (
        <DataState
          kind="unavailable"
          detail={`Origen ${trace.value.evidence.origin ?? 'sin configurar'}: ${trace.value.detail}`}
        />
      )}
      {trace.state === 'ready' && trace.value.state === 'not_found' && (
        <DataState
          kind="nodata"
          title="Sin veredicto"
          detail={`La fuente se leyó y no tiene un veredicto de ${trace.value.product} para el minuto ${utcMinute(trace.value.bucketStartMs)}.`}
        />
      )}
      {trace.state === 'ready' && trace.value.state === 'ok' && (
        <>
          <h2 className="inv-trace__title">
            {utcClock(trace.value.decision.bucketStartMs)}
            <small>{trace.value.product} · Kraken Futures</small>
          </h2>
          {trace.value.payloadState !== 'ok' && (
            <DataState
              kind="unavailable"
              title="Payload no disponible"
              detail={`El payload guardado no se pudo usar (${trace.value.payloadState}); solo se muestran las columnas de la fila.`}
            />
          )}
          {trace.value.mismatches.length > 0 && (
            <DataState
              kind="error"
              title="La fila y el payload no coinciden"
              detail={`Campos en desacuerdo: ${trace.value.mismatches.join(', ')}.`}
            />
          )}
          <Pipeline trace={trace.value} />
          <div className="inv-trace__foot">
            <button type="button" onClick={() => exportTrace(trace.value)}>
              Exportar JSON
            </button>
            <a href="/terminal">Volver a la Terminal</a>
          </div>
        </>
      )}
    </aside>
  )
}

function Summary({
  trace,
  product,
}: {
  trace: Loaded<DecisionTrace>
  product: string
}) {
  const ok =
    trace.state === 'ready' && trace.value.state === 'ok' ? trace.value : null
  const payload = ok?.payload ?? null
  const decision = ok?.decision ?? null
  const strategy = payload?.selected?.strategyId ?? null
  return (
    <section className="inv-cards" aria-label="Resumen del veredicto">
      <div className="inv-card">
        <p className="inv-label">Producto · veredicto</p>
        <p className="inv-card__big">{product}</p>
        <p className="obs-note">
          Kraken Futures ·{' '}
          {decision
            ? `bucket de ${decision.intervalMs / 60_000} min ${utcMinute(decision.bucketStartMs)}`
            : 'sin veredicto seleccionado'}
        </p>
      </div>
      <div className="inv-card" data-testid="card-action">
        <p className="inv-label">Acción del veredicto</p>
        <p className="inv-card__big">
          {decision ? <ActionTag action={decision.action} /> : <Na />}
        </p>
        <p className="obs-note">
          {decision && isDirectional(decision.action)
            ? 'Propuesta direccional. No es una orden ejecutada.'
            : decision
              ? 'Sin propuesta direccional en este minuto.'
              : ''}
        </p>
      </div>
      <div className="inv-card" data-testid="card-reason">
        <p className="inv-label">Motivo registrado</p>
        <p className="inv-card__big inv-card__big--code">
          {decision ? decision.reasonCode : <Na />}
        </p>
        <p className="obs-note">
          {decision
            ? reasonOrigin(decision.action, strategy, payload !== null)
            : ''}
        </p>
      </div>
      <div className="inv-card" data-testid="card-regime">
        <p className="inv-label">Régimen · funding · flujo</p>
        <p className="inv-card__big inv-card__big--code">
          {decision ? decision.regime : <Na />}
        </p>
        <p className="obs-note">
          Funding, flujo y volatilidad de mercado: No disponible, no se
          persisten por decisión.
        </p>
      </div>
    </section>
  )
}

function Features({ trace }: { trace: Loaded<DecisionTrace> }) {
  const payload =
    trace.state === 'ready' && trace.value.state === 'ok'
      ? trace.value.payload
      : null
  const sets = useMemo(() => payload?.features ?? [], [payload])
  const names = useMemo(() => {
    const seen = new Set<string>()
    for (const set of sets) for (const [name] of set.entries) seen.add(name)
    return [...seen].filter((n) => n !== 'schema_version')
  }, [sets])
  return (
    <section className="inv-panel" aria-label="Indicadores del motor">
      <p className="inv-label">
        Indicadores que usó el motor en este bucket
        <span className="obs-note"> · valores del payload, sin recalcular</span>
      </p>
      {sets.length === 0 ? (
        <DataState
          kind="unavailable"
          detail={
            trace.state === 'ready' && trace.value.state === 'ok'
              ? 'El payload de este veredicto no trae indicadores.'
              : 'Elegí un veredicto con traza.'
          }
        />
      ) : (
        <div className="inv-features" data-testid="features">
          <table>
            <thead>
              <tr>
                <th>Indicador</th>
                {sets.map((s) => (
                  <th key={s.key}>{s.key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {names.map((name) => (
                <tr key={name}>
                  <td>
                    <code>{name}</code>
                  </td>
                  {sets.map((s) => {
                    const found = s.entries.find(([n]) => n === name)
                    return (
                      <td key={s.key}>
                        {found ? scalarText(found[1]) : NOT_AVAILABLE}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function DecisionRows({
  items,
  selected,
  onSelect,
  onReason,
}: {
  items: readonly DecisionItem[]
  selected: number | null
  onSelect: (bucket: number) => void
  onReason: (code: string) => void
}) {
  return (
    <table className="inv-table" data-testid="decision-list">
      <thead>
        <tr>
          <th>Hora UTC</th>
          <th>Veredicto</th>
          <th>Motivo registrado</th>
          <th>Régimen</th>
          <th>Estrategia (payload)</th>
          <th>Operación almacenada</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const strategy = rowStrategy(item)
          return (
            <tr
              key={item.bucketStartMs}
              data-selected={item.bucketStartMs === selected}
              data-action={item.action}
            >
              <td>
                <button
                  type="button"
                  className="inv-table__pick"
                  aria-pressed={item.bucketStartMs === selected}
                  onClick={() => onSelect(item.bucketStartMs)}
                >
                  {utcClock(item.bucketStartMs)}
                </button>
              </td>
              <td>
                <ActionTag action={item.action} />
              </td>
              <td>
                <button
                  type="button"
                  className="inv-table__reason"
                  title="Filtrar por este motivo"
                  onClick={() => onReason(item.reasonCode)}
                >
                  <code>{item.reasonCode}</code>
                </button>
              </td>
              <td>
                <code>{item.regime}</code>
              </td>
              <td>{strategy ? <code>{strategy}</code> : '—'}</td>
              <td>
                {isDirectional(item.action) ? (
                  <Na>No disponible (B5)</Na>
                ) : (
                  'No corresponde'
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * «Investigación de decisiones»: the verdicts of one product, minute by
 * minute, and the trace of the one selected. Everything comes from the B3
 * endpoints (`docs/observabilidad-decisiones-api.md`); what they do not carry
 * is shown as «No disponible» with its reason, never filled in.
 */
export default function DecisionsPage({
  products,
  initialProduct,
  initialBucket,
}: {
  products: readonly string[]
  initialProduct: string
  initialBucket: number | null
}) {
  const [product, setProduct] = useState(initialProduct)
  const [span, setSpan] = useState<SpanId>('3h')
  const [action, setAction] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [bucket, setBucket] = useState<number | null>(initialBucket)
  const [tick, setTick] = useState(0)
  const [moreState, setMore] = useState<{
    key: string
    items: DecisionItem[]
    nextCursor: string | null
    loading: boolean
    error: string | null
  } | null>(null)
  const pages = useRef<AbortController | null>(null)

  // The first page: again whenever the question changes or the user refreshes.
  const firstKey = `${product}|${span}|${action ?? ''}|${reason ?? ''}|${tick}`
  const loadFirst = useCallback(
    (signal: AbortSignal) => {
      const now = Date.now()
      const toMs = now - (now % 60_000)
      return fetchDecisions(
        {
          product,
          fromMs: toMs - SPANS.find((s) => s.id === span)!.ms,
          toMs,
          limit: PAGE_SIZE,
          action,
          reasonCode: reason,
        },
        signal,
      )
    },
    // `tick` is not read: refreshing means asking again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [product, span, action, reason, tick],
  )
  const first = useKeyed(firstKey, loadFirst)
  const readAt = first.state === 'ready' ? first.at : null
  const more = moreState?.key === firstKey ? moreState : null
  useEffect(() => () => pages.current?.abort(), [firstKey])

  const section =
    first.state === 'ready' && first.value.decisions.state === 'ok'
      ? first.value.decisions
      : null
  const items = useMemo(
    () => (section ? [...section.items, ...(more?.items ?? [])] : []),
    [section, more],
  )
  const nextCursor = more ? more.nextCursor : (section?.nextCursor ?? null)

  // With nothing chosen, the newest verdict of the list opens its trace.
  const newest = section?.items[0]?.bucketStartMs ?? null
  const shown = bucket ?? newest

  const loadTrace = useCallback(
    (signal: AbortSignal) => fetchTrace(product, shown ?? 0, signal),
    [product, shown],
  )
  const trace = useKeyed(
    shown === null ? null : `${product}|${shown}|${tick}`,
    loadTrace,
  )

  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('product', product)
      if (bucket === null) url.searchParams.delete('bucket')
      else url.searchParams.set('bucket', String(bucket))
      window.history.replaceState(null, '', url)
    } catch {
      // The address bar is a convenience, never a requirement.
    }
  }, [product, bucket])

  const loadMore = () => {
    if (first.state !== 'ready' || !nextCursor) return
    const report = first.value
    const cursor = nextCursor
    pages.current?.abort()
    const abort = new AbortController()
    pages.current = abort
    setMore({
      key: firstKey,
      items: more?.items ?? [],
      nextCursor: cursor,
      loading: true,
      error: null,
    })
    fetchDecisions(
      {
        product,
        fromMs: report.fromMs,
        toMs: report.toMs,
        limit: PAGE_SIZE,
        cursor,
        action,
        reasonCode: reason,
      },
      abort.signal,
    )
      .then((page) => {
        if (abort.signal.aborted) return
        if (page.decisions.state !== 'ok')
          throw new Error('la fuente dejó de estar disponible')
        const body = page.decisions
        setMore((prev) => ({
          key: firstKey,
          items: [...(prev?.items ?? []), ...body.items],
          nextCursor: body.nextCursor,
          loading: false,
          error: null,
        }))
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return
        setMore((prev) => ({
          key: firstKey,
          items: prev?.items ?? [],
          nextCursor: cursor,
          loading: false,
          error: errorText(cause),
        }))
      })
  }

  const pick = (next: string | null) => {
    setAction(next)
    setBucket(null)
  }

  return (
    <div className="inv" data-testid="investigation">
      <div className="inv-bar">
        <span className="inv-bar__mode">Modo investigación</span>
        <label>
          Producto{' '}
          <select
            aria-label="Producto de la investigación"
            value={product}
            onChange={(event) => {
              setProduct(event.target.value)
              setBucket(null)
            }}
          >
            {(products.includes(product)
              ? products
              : [product, ...products]
            ).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        {trace.state === 'ready' && trace.value.state === 'ok' && (
          <span>
            Veredicto de las{' '}
            <b>{utcMinute(trace.value.decision.bucketStartMs)}</b> ·{' '}
            {utcDay(trace.value.decision.bucketStartMs)}
          </span>
        )}
        <span className="inv-bar__right">
          Solo lectura · traza por intervalo (B3)
        </span>
      </div>

      <div className="inv-grid">
        <div className="inv-main">
          <Summary trace={trace} product={product} />
          <Features trace={trace} />
          <section className="inv-panel inv-log" aria-label="Veredictos">
            <div className="inv-log__head">
              <p className="inv-label">
                Registro de veredictos · {product}
                {readAt !== null && (
                  <span className="obs-note">
                    {' '}
                    · leído a las {utcClock(readAt)}
                  </span>
                )}
              </p>
              <div className="inv-filters">
                <div role="group" aria-label="Ventana" className="obs-seg">
                  {SPANS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={s.id === span}
                      onClick={() => {
                        setSpan(s.id)
                        setBucket(null)
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <div
                  role="group"
                  aria-label="Filtrar por acción"
                  className="obs-seg"
                >
                  <button
                    type="button"
                    aria-pressed={action === null}
                    onClick={() => pick(null)}
                  >
                    Todos
                    {section && action === null ? ` ${section.rangeTotal}` : ''}
                  </button>
                  {ACTIONS.map((a) => {
                    const count = section?.byAction.find(
                      (x) => x.action === a,
                    )?.count
                    return (
                      <button
                        key={a}
                        type="button"
                        aria-pressed={action === a}
                        onClick={() => pick(a)}
                      >
                        {a}
                        {count !== undefined ? ` ${count}` : ''}
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  className="inv-refresh"
                  onClick={() => setTick((n) => n + 1)}
                >
                  Actualizar
                </button>
              </div>
            </div>
            {reason !== null && (
              <p className="inv-chip" data-testid="reason-filter">
                Motivo: <code>{reason}</code>
                <button
                  type="button"
                  onClick={() => {
                    setReason(null)
                    setBucket(null)
                  }}
                  aria-label="Quitar el filtro de motivo"
                >
                  ×
                </button>
              </p>
            )}
            {first.state === 'loading' && <DataState kind="loading" />}
            {first.state === 'error' && (
              <DataState
                kind="error"
                title="No se pudo leer el registro de veredictos"
                detail={first.message}
              />
            )}
            {first.state === 'ready' &&
              first.value.decisions.state === 'unavailable' && (
                <DataState
                  kind="unavailable"
                  detail={`Origen ${first.value.decisions.evidence.origin ?? 'sin configurar'}: ${first.value.decisions.detail}`}
                />
              )}
            {section && items.length === 0 && (
              <DataState
                kind="nodata"
                title="Sin veredictos"
                detail={
                  section.rangeTotal === 0
                    ? 'La fuente se leyó y no tiene veredictos de este producto en la ventana.'
                    : 'Ningún veredicto de la ventana coincide con el filtro.'
                }
              />
            )}
            {section && items.length > 0 && (
              <>
                <div className="inv-log__scroll">
                  <DecisionRows
                    items={items}
                    selected={shown}
                    onSelect={setBucket}
                    onReason={(code) => {
                      setReason(code)
                      setBucket(null)
                    }}
                  />
                </div>
                <p className="obs-note" data-testid="list-count">
                  Mostrando {items.length} de {section.matching}{' '}
                  {section.matching === 1 ? 'veredicto' : 'veredictos'}
                  {section.matching !== section.rangeTotal &&
                    ` (la ventana tiene ${section.rangeTotal})`}
                  . Un veredicto LONG o SHORT es una propuesta, no una
                  operación.
                </p>
                {more?.error && (
                  <DataState
                    kind="error"
                    title="No se pudo cargar la página siguiente"
                    detail={more.error}
                  />
                )}
                {nextCursor && (
                  <button
                    type="button"
                    className="inv-more"
                    onClick={loadMore}
                    disabled={more?.loading === true}
                  >
                    {more?.loading ? 'Cargando…' : 'Cargar más antiguos'}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
        {shown !== null ? (
          <TraceColumn trace={trace} />
        ) : (
          <aside className="inv-trace" aria-label="Investigación de decisión">
            <p className="inv-label inv-label--accent">
              Investigación de decisión
            </p>
            <DataState
              kind="nodata"
              title="Sin veredicto para investigar"
              detail="Cuando el registro tenga veredictos, el más reciente abre su traza acá."
            />
          </aside>
        )}
      </div>
      {section && (
        <p className="inv-foot" data-testid="not-recorded">
          No se registra por veredicto: {section.notRecorded.join('; ')}.
        </p>
      )}
    </div>
  )
}
