import {
  DataState,
  Panel,
  StatusPill,
  type StatusTone,
} from '../../../shared/mission-control/index.ts'
import type {
  HealthCheck,
  HealthComponent,
  HealthReport,
  HealthStatus,
} from '../infrastructure/observability-api.ts'
import { momentLabel } from './format.ts'

const TONE: Record<HealthStatus, StatusTone> = {
  ok: 'ok',
  warning: 'warn',
  error: 'bad',
  // «Sin datos» is not healthy and not failing: it stays neutral.
  unknown: 'nodata',
}

const LABEL: Record<HealthStatus, string> = {
  ok: 'Correcto',
  warning: 'Advertencia',
  error: 'Error',
  unknown: 'Sin datos',
}

const COMPONENT_LABELS: Record<string, string> = {
  data: 'Datos',
  processing: 'Procesamiento',
  strategies: 'Estrategias',
  decisions: 'Decisiones',
  paper: 'Ejecución paper',
  risk: 'Riesgo',
}

function checkValue(check: HealthCheck): string {
  if (check.value === null) return 'Sin datos'
  return typeof check.value === 'number'
    ? check.value.toLocaleString('es-ES')
    : check.value
}

function Component({
  component,
  reference,
}: {
  component: HealthComponent
  reference: number
}) {
  return (
    <li
      className="obs-component"
      data-status={component.status}
      data-testid={`health-${component.id}`}
    >
      <div className="obs-component__head">
        <h3 className="obs-component__title">{component.label}</h3>
        <StatusPill tone={TONE[component.status]}>
          {LABEL[component.status]}
        </StatusPill>
      </div>
      <p className="obs-component__summary">{component.summary}</p>
      <details className="obs-details">
        <summary>
          Comprobaciones ({component.checks.length}) y evidencia (
          {component.evidence.length})
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
                <span className="obs-checks__value">{checkValue(check)}</span>
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
                  {item.detail ? ` (${item.detail})` : ''} · última
                  actualización: {momentLabel(item.lastUpdatedMs, reference)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </details>
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
    </li>
  )
}

export default function HealthSection({
  report,
  stale,
}: {
  report: HealthReport
  /** The latest refresh failed: what is shown is an older read. */
  stale: boolean
}) {
  const { overall } = report
  const names = (ids: string[]) =>
    ids.map((id) => COMPONENT_LABELS[id] ?? id).join(', ')
  return (
    <Panel
      eyebrow="B1 · solo lectura"
      title="Salud del sistema"
      actions={
        <StatusPill tone={TONE[overall.status]}>
          {LABEL[overall.status]}
        </StatusPill>
      }
      label="Salud del sistema"
    >
      <p className="obs-overall" data-testid="health-overall">
        {overall.reason}
      </p>
      {overall.failing.length > 0 && (
        <p className="obs-overall__list">
          Con problemas: <strong>{names(overall.failing)}</strong>
        </p>
      )}
      {overall.unverified.length > 0 && (
        <p className="obs-overall__list">
          Sin verificar: <strong>{names(overall.unverified)}</strong>. Mientras
          haya componentes sin verificar el estado global nunca es correcto.
        </p>
      )}
      <p className="obs-meta">
        Informe del gateway:{' '}
        {momentLabel(report.generatedAtMs, report.generatedAtMs)}
        {stale
          ? ' · la última actualización falló: se muestra la lectura anterior'
          : ''}
      </p>
      {report.components.length === 0 ? (
        <DataState kind="nodata" detail="El gateway no devolvió componentes." />
      ) : (
        <ul className="obs-components" aria-label="Componentes de salud">
          {report.components.map((component) => (
            <Component
              key={component.id}
              component={component}
              reference={report.generatedAtMs}
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}
