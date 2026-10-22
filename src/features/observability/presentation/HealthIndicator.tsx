import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import './observability.css'
import { StatusPill, DataState } from '../../../shared/mission-control/index.ts'
import {
  type HealthComponent,
  type HealthReport,
} from '../infrastructure/observability-api.ts'
import { LABEL, TONE, componentOrder, reportTiming } from './health-view.ts'
import { duration, momentLabel } from './format.ts'
import { utcDateTime } from '../../../shared/finance/format.ts'

function ageLabel(age: number | null): string {
  if (age === null) return 'sin verificar'
  return age < 0 ? 'en el futuro (desfase de reloj)' : `hace ${duration(age)}`
}

function ComponentRow({
  component,
  index,
  reference,
}: {
  component: HealthComponent
  index: number
  reference: number | null
}) {
  const failing = component.checks.filter(
    (check) => check.status === 'warning' || check.status === 'error',
  )
  return (
    <li
      className="obs-row"
      data-status={component.status}
      data-testid={`health-${component.id}`}
    >
      <div className="obs-row__head">
        <h3 className="obs-row__title">
          {index}. {component.label}
        </h3>
        <StatusPill tone={TONE[component.status]}>
          {LABEL[component.status]}
        </StatusPill>
      </div>
      <p className="obs-row__summary">{component.summary}</p>
      <details className="obs-details">
        <summary>
          {failing.length > 0
            ? 'Comprobaciones, regla y evidencia'
            : 'Evidencia'}{' '}
          ({component.checks.length} comprobaciones ·{' '}
          {component.evidence.length} fuentes)
        </summary>
        {component.checks.length > 0 && (
          <ul className="obs-checks">
            {component.checks.map((check) => (
              <li key={check.id} data-status={check.status}>
                <span className="obs-checks__label">
                  {check.label}
                  {check.required ? '' : ' (informativa)'}
                </span>
                <StatusPill tone={TONE[check.status]}>
                  {LABEL[check.status]}
                </StatusPill>
                <span className="obs-checks__rule">{check.rule}</span>
                {check.detail && (
                  <span className="obs-checks__detail">{check.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {component.evidence.length > 0 && (
          <dl className="obs-evidence">
            {component.evidence.map((item) => (
              <div key={`${item.source}|${item.origin ?? ''}`}>
                <dt>{item.source}</dt>
                <dd>
                  {item.origin ?? 'Sin origen'} · {item.state}
                  {item.detail ? ` (${item.detail})` : ''} · última lectura:{' '}
                  {item.lastUpdatedMs === null
                    ? 'Sin datos'
                    : reference === null || item.lastUpdatedMs > reference
                      ? `${utcDateTime(item.lastUpdatedMs)} · edad sin verificar`
                      : momentLabel(item.lastUpdatedMs, reference)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {component.limitations.length > 0 && (
          <div className="obs-limitations">
            <p className="obs-limitations__title">Limitaciones</p>
            <ul>
              {component.limitations.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        )}
      </details>
    </li>
  )
}

function Inspector({
  report,
  error,
  applicable,
  timing,
  qualification,
  tone,
  extra,
  onClose,
}: {
  report: HealthReport | null
  error: string | null
  applicable: boolean
  timing: ReturnType<typeof reportTiming> | null
  qualification: string | null
  tone: keyof typeof LABEL | 'none'
  extra?: ReactNode
  onClose: () => void
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const groups = report ? componentOrder(report.components) : []
  return (
    <div
      className="obs-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="obs-inspector"
        role="dialog"
        aria-modal="true"
        aria-label="Salud del sistema"
        data-testid="health-inspector"
      >
        <header className="obs-inspector__head">
          <div>
            <h2>Salud del sistema</h2>
            {report && (
              <p className="obs-inspector__meta">
                Generación: {ageLabel(timing?.generationAge ?? null)} ·{' '}
                Recepción: {ageLabel(timing?.receiptAge ?? null)} · hora
                gateway:{' '}
                {Number.isFinite(report.generatedAtMs)
                  ? utcDateTime(report.generatedAtMs)
                  : 'sin verificar'}
              </p>
            )}
          </div>
          {report && (
            <StatusPill tone={tone === 'none' ? 'nodata' : TONE[tone]}>
              {qualification ? 'Lectura anterior · ' : ''}
              {LABEL[report.overall.status]}
            </StatusPill>
          )}
        </header>
        <div className="obs-inspector__body">
          {extra && (
            <section className="obs-flow" aria-label="Flujo y uso">
              {extra}
            </section>
          )}
          {!applicable && (
            <DataState
              kind="unavailable"
              title="Salud B1: no disponible en este modo"
              detail="Los seis componentes se leen solo del gateway real. No se muestra ningún estado inventado."
            />
          )}
          {applicable && error !== null && (
            <DataState
              kind="error"
              title="No se pudo leer la salud"
              detail={
                report
                  ? `${error}. Debajo queda la lectura anterior, no la actual.`
                  : `${error}. No se muestra ningún estado anterior como actual.`
              }
            />
          )}
          {applicable && report ? (
            <>
              {qualification && (
                <p className="obs-inspector__meta">
                  Lectura anterior: {qualification}. Estados, conteos y motivos
                  de abajo son evidencia previa, no una evaluación actual.
                </p>
              )}
              <p
                className="obs-inspector__overall"
                data-testid="health-overall"
              >
                {report.overall.reason}
              </p>
              {groups.map((group) => (
                <section key={group.title} aria-label={group.title}>
                  <p className="obs-group">
                    {group.title} ({group.items.length})
                  </p>
                  <ul className="obs-rows">
                    {group.items.map(({ component, index }) => (
                      <ComponentRow
                        key={component.id}
                        component={component}
                        index={index}
                        reference={timing?.reference ?? null}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          ) : (
            applicable && error === null && <DataState kind="loading" />
          )}
        </div>
        <footer className="obs-inspector__foot">
          <span>
            Solo lectura: el inspector no reinicia ni controla procesos.
          </span>
          <button ref={closeButton} type="button" onClick={onClose}>
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  )
}

export type HealthRead = {
  data: HealthReport | null
  error: string | null
  receivedAt?: number | null
}

/** What the header says about the data flow, next to the health read. */
export type FlowFace = {
  level: 'ok' | 'warn' | 'bad'
  text: string
  /** «PAPER»: operations are simulated. */
  mode: string
}

const FLOW_TONE = { ok: 'ok', warn: 'warning', bad: 'error' } as const

/**
 * The one status control of the header: the global health read of B1 (the
 * source of truth for health) with the live flow and the PAPER mark as
 * details in the same chip. It opens the inspector, which also carries the
 * flow diagnosis (`extra`). Without a B1 read it says «Salud: sin datos»,
 * never healthy; where B1 does not apply (`health` omitted) the dot follows
 * the flow only and the inspector says so.
 */
export default function HealthIndicator({
  data,
  error,
  receivedAt,
  applicable = true,
  flow,
  extra,
}: HealthRead & { applicable?: boolean; flow?: FlowFace; extra?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now)
  // The clock always runs so `now` is never older than a tick when a report arrives.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const timing = data ? reportTiming(now, receivedAt, data.generatedAtMs) : null
  const qualification = !data
    ? null
    : error !== null
      ? 'error de actualización'
      : timing?.state === 'unverified'
        ? 'frescura/reloj sin verificar'
        : timing?.state === 'stale'
          ? 'informe obsoleto'
          : null
  const close = useCallback(() => setOpen(false), [])
  let tone: keyof typeof LABEL | 'none' = 'none'
  let text = 'Salud: sin datos'
  if (data) {
    tone = data.overall.status
    const failing = data.overall.failing.length
    const unverified = data.overall.unverified.length
    const ok = data.components.filter((c) => c.status === 'ok').length
    text =
      failing > 0
        ? `Salud: ${failing} con problemas`
        : unverified > 0
          ? `Salud: ${unverified} sin verificar`
          : 'Salud: correcta'
    if (data.components.length > 0) text += ` · ${ok}/${data.components.length}`
    if (qualification) {
      text += ` (lectura anterior: ${qualification})`
      if (tone === 'ok') tone = 'unknown'
    }
  }
  if (!applicable) {
    tone = flow ? FLOW_TONE[flow.level] : 'none'
    text = ''
  }
  return (
    <>
      <button
        type="button"
        className="obs-health"
        data-tone={tone}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="health-indicator"
        onClick={() => setOpen(true)}
        title={
          applicable && qualification
            ? `Lectura anterior: ${qualification}`
            : 'Abrir el estado del sistema'
        }
      >
        <span className="obs-health__dot" aria-hidden="true" />
        {applicable && <span>{text}</span>}
        {flow && (
          <>
            <span
              className="obs-health__flow"
              data-level={flow.level}
              data-testid="flow-status"
            >
              {flow.text}
            </span>
            <span className="obs-health__mode">{flow.mode}</span>
          </>
        )}
      </button>
      {open && (
        <Inspector
          report={data}
          error={error}
          applicable={applicable}
          timing={timing}
          qualification={qualification}
          tone={tone}
          extra={extra}
          onClose={close}
        />
      )}
    </>
  )
}
