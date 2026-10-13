import { useCallback, useEffect, useRef, useState } from 'react'
import './observability.css'
import { StatusPill, DataState } from '../../../shared/mission-control/index.ts'
import {
  fetchHealth,
  type HealthComponent,
  type HealthReport,
} from '../infrastructure/observability-api.ts'
import { useReport } from '../infrastructure/useReport.ts'
import { LABEL, TONE, componentOrder } from './health-view.ts'
import { momentLabel } from './format.ts'

function ComponentRow({
  component,
  index,
  reference,
}: {
  component: HealthComponent
  index: number
  reference: number
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
                  {momentLabel(item.lastUpdatedMs, reference)}
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
  onClose,
}: {
  report: HealthReport | null
  error: string | null
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
                Informe del gateway:{' '}
                {momentLabel(report.generatedAtMs, report.generatedAtMs)}
              </p>
            )}
          </div>
          {report && (
            <StatusPill tone={TONE[report.overall.status]}>
              {LABEL[report.overall.status]}
            </StatusPill>
          )}
        </header>
        <div className="obs-inspector__body">
          {error !== null && (
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
          {report ? (
            <>
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
                        reference={report.generatedAtMs}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          ) : (
            error === null && <DataState kind="loading" />
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

/**
 * Header control: the global health read of B1 at a glance, with the
 * inspector behind it. Without a read it says «Salud: sin datos», never
 * healthy.
 */
export default function HealthIndicator() {
  const load = useCallback((signal: AbortSignal) => fetchHealth(signal), [])
  const { data, error } = useReport(load)
  const [open, setOpen] = useState(false)
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
          error !== null && data
            ? 'La última lectura falló: se muestra la anterior'
            : 'Abrir el inspector de salud'
        }
      >
        <span className="obs-health__dot" aria-hidden="true" />
        {text}
        {error !== null && data ? ' (lectura anterior)' : ''}
      </button>
      {open && <Inspector report={data} error={error} onClose={close} />}
    </>
  )
}
