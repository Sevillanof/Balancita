import { useCallback, useState, type ReactNode } from 'react'
import './observability.css'
import {
  DataState,
  Metric,
  StatusPill,
} from '../../../shared/mission-control/index.ts'
import {
  ACTIVITY_WINDOWS,
  fetchActivity,
  type ActivityReport,
  type ActivityWindow,
  type Section,
} from '../infrastructure/observability-api.ts'
import { useReport } from '../infrastructure/useReport.ts'
import { utcDateTime } from '../../../shared/finance/format.ts'
import { duration, momentLabel, shortProduct, sideLabel } from './format.ts'
import { LABEL, TONE } from './health-view.ts'
import type { HealthRead } from './HealthIndicator.tsx'
import type { LatestDecision } from './latest-decision.ts'

const WINDOW_LABELS: Record<ActivityWindow, string> = {
  '3h': '3 h',
  '24h': '24 h',
}
const TOP_REASONS = 3

function Unavailable({ section }: { section: Section<object> }) {
  if (section.state !== 'unavailable') return null
  return (
    <DataState
      kind="unavailable"
      detail={`Origen ${section.evidence.origin ?? 'sin configurar'}: ${section.detail}`}
    />
  )
}

function decisionLabel(action: string): string {
  return action === 'WAIT' ? 'Espera' : action
}

/**
 * AHORA: what is known about the engine at this moment. The last decision is
 * shown only when it comes from a real analysis the Terminal stream delivered
 * for this product (`latest`); B2 gives aggregates, never an individual
 * decision, so without an analysis the line says «No disponible». The health
 * of the decisions source (B1) is a separate fact.
 */
function Now({
  report,
  health,
  latest,
  nowMs,
}: {
  report: ActivityReport | null
  health: HealthRead
  latest: LatestDecision | null
  nowMs: number
}) {
  const decisions = health.data?.components.find((c) => c.id === 'decisions')
  const mine =
    report?.evaluations.state === 'ok' && report.product
      ? (report.evaluations.byProduct.find(
          (p) => p.product === report.product,
        ) ?? null)
      : null
  const windowLabel = report ? WINDOW_LABELS[report.window] : null
  return (
    <section className="obs-now" aria-label="Ahora" data-testid="observer-now">
      <p className="obs-card__label">Ahora</p>
      <p className="obs-card__big" data-testid="last-decision">
        Última decisión:{' '}
        {latest ? (
          <>
            <strong data-action={latest.action} data-testid="now-action">
              {decisionLabel(latest.action)}
            </strong>
            {latest.action === 'LONG' || latest.action === 'SHORT' ? (
              <small className="obs-now__kind"> propuesta, no operación</small>
            ) : null}
          </>
        ) : (
          <span className="obs-na">No disponible</span>
        )}
        <span className="obs-card__pill">
          <span className="obs-card__pill-label">Salud de la fuente</span>
          {decisions ? (
            <StatusPill tone={TONE[decisions.status]}>
              {LABEL[decisions.status]}
            </StatusPill>
          ) : (
            <span className="obs-na">Sin datos</span>
          )}
        </span>
      </p>
      {latest && (
        <p className="obs-summary" data-testid="now-detail">
          {latest.reasonCode ? <code>{latest.reasonCode}</code> : 'Sin motivo'}
          {' · '}Régimen {latest.regime ?? 'No disponible'}
          {' · '}
          {utcDateTime(latest.decisionTimeMs)} · hace{' '}
          {duration(nowMs - latest.decisionTimeMs)}
          <small className="obs-now__source" data-testid="now-source">
            {' '}
            Fuente: análisis del motor recibido por el stream de la Terminal
            {latest.action === 'WAIT'
              ? '. Esperar no es un error: ninguna estrategia propuso entrar.'
              : '.'}
          </small>
        </p>
      )}
      {report && mine && report.signals.state === 'ok' && (
        <p className="obs-summary" data-testid="window-summary">
          Últimas {windowLabel} · {mine.count}{' '}
          {mine.count === 1 ? 'evaluación' : 'evaluaciones'} ·{' '}
          {report.signals.total}{' '}
          {report.signals.total === 1
            ? 'propuesta direccional'
            : 'propuestas direccionales'}
        </p>
      )}
      <details className="obs-details obs-details--inline">
        <summary>Qué fuentes respaldan esto</summary>
        <p className="obs-note">
          {latest
            ? 'La última decisión es la del último análisis del motor recibido por el stream de este producto; los agregados de B2 no se usan para deducirla. '
            : 'Ninguna fuente verificable entrega la última decisión individual de este producto (llegará con B3). '}
          El estado es el de la fuente de decisiones según B1 (Fuente de
          decisiones (B1)).
        </p>
        <p className="obs-note">
          Última evaluación registrada:{' '}
          {report && mine?.lastBucketMs != null
            ? momentLabel(mine.lastBucketMs, report.generatedAtMs)
            : 'Sin datos'}
        </p>
      </details>
    </section>
  )
}

function Activity({ report }: { report: ActivityReport }) {
  const { evaluations, signals, discards } = report
  const mine =
    evaluations.state === 'ok' && report.product
      ? (evaluations.byProduct.find((p) => p.product === report.product) ??
        null)
      : null
  return (
    <section className="obs-card" aria-label="Actividad de la ventana">
      <p className="obs-card__label">
        Actividad · {report.product ? shortProduct(report.product) : 'todos'}
      </p>
      <div className="obs-metrics">
        <Metric
          label="Evaluaciones"
          value={
            mine
              ? `${mine.count} / ${mine.expected}`
              : evaluations.state === 'ok'
                ? evaluations.total
                : 'Sin datos'
          }
          hint={
            mine
              ? `${mine.missing} min sin veredicto de 1 por minuto`
              : undefined
          }
        />
        <Metric
          label="Propuestas direccionales"
          value={signals.state === 'ok' ? signals.total : 'Sin datos'}
          hint={
            signals.state === 'ok'
              ? `${signals.long} largo · ${signals.short} corto · no son operaciones`
              : undefined
          }
        />
      </div>
      {mine?.lastSignal && (
        <p className="obs-note" data-testid="last-proposal">
          Última propuesta: {mine.lastSignal.action} ·{' '}
          {mine.lastSignal.reasonCode} ·{' '}
          {momentLabel(mine.lastSignal.bucketMs, report.generatedAtMs)}
        </p>
      )}
      <p className="obs-card__label obs-card__label--sub">
        Motivos de espera y descarte
      </p>
      {discards.state !== 'ok' ? (
        <Unavailable section={discards} />
      ) : discards.byReason.length === 0 ? (
        <p className="obs-note">Sin descartes en la ventana.</p>
      ) : (
        <>
          <ul className="obs-reasons" data-testid="activity-discards">
            {discards.byReason.slice(0, TOP_REASONS).map((r) => (
              <li key={`${r.action}|${r.reasonCode}`}>
                <code>{r.reasonCode}</code>
                <span className="obs-reasons__action">{r.action}</span>
                <span className="obs-reasons__count">{r.count}×</span>
              </li>
            ))}
          </ul>
          {(discards.byReason.length > TOP_REASONS || discards.truncated) && (
            <p className="obs-note" data-testid="discards-more">
              Se muestran los {TOP_REASONS} motivos más frecuentes de{' '}
              {discards.distinctReasons}. El total ({discards.total}) los
              incluye todos.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function Results({ report }: { report: ActivityReport }) {
  const { operations } = report
  const stored =
    operations.state === 'ok'
      ? operations.experiments.reduce((sum, e) => sum + e.tradesInWindow, 0)
      : null
  return (
    <section className="obs-card" aria-label="Operaciones almacenadas">
      <p className="obs-card__label">
        Resultados · operaciones almacenadas en la ventana
        <strong data-testid="stored-total">
          {stored === null ? 'Sin datos' : stored}
        </strong>
      </p>
      {operations.state !== 'ok' ? (
        <Unavailable section={operations} />
      ) : (
        <>
          {stored === 0 && (
            <p className="obs-note">
              Sin entradas almacenadas en la ventana. Una propuesta no es una
              operación.
            </p>
          )}
          <ul className="obs-exps" data-testid="activity-experiments">
            {operations.experiments.map((e) => (
              <li key={e.experimentId}>
                <strong>{e.experimentId}</strong>
                <span>
                  {e.lastTrade
                    ? `Última: ${shortProduct(e.lastTrade.product)} ${sideLabel(e.lastTrade.side).toLowerCase()}${e.lastTrade.exitReason ? ` · salida ${e.lastTrade.exitReason}` : ''} · ${momentLabel(e.lastTrade.entryBucketMs, report.generatedAtMs)}`
                    : 'Ninguna almacenada'}
                  <small>
                    Último ciclo propio:{' '}
                    {momentLabel(e.lastCycleMs, report.generatedAtMs)}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/**
 * The one right-hand column of the Terminal: AHORA, ACTIVIDAD, RESULTADOS and
 * HISTORIAL (the decisions list the Terminal already had, passed in). It never
 * turns a proposal into an execution nor a stored record into a position.
 */
export default function ObserverPanel({
  product,
  health,
  latest = null,
  nowMs,
  children,
}: {
  product: string | null
  health: HealthRead
  /** Last real analysis of the stream for this product, or null. */
  latest?: LatestDecision | null
  /** Clock the decision's age is measured against. */
  nowMs: number
  /** The decisions history the Terminal already renders. */
  children?: ReactNode
}) {
  const [window, setWindow] = useState<ActivityWindow>('3h')
  const load = useCallback(
    (signal: AbortSignal) => fetchActivity(window, product, signal),
    [window, product],
  )
  const { data, error } = useReport(load)
  // A read belongs to the window and product asked for; otherwise it is an
  // older read of something else and must not be shown as this one.
  const current =
    data && data.window === window && data.product === product ? data : null
  return (
    <section
      className="demo-terminal__panel obs-observer"
      aria-label="Observador del motor"
      data-testid="activity-panel"
    >
      <div className="obs-observer__head">
        <h2>Observador del motor</h2>
        <div role="group" aria-label="Ventana de tiempo" className="obs-seg">
          {ACTIVITY_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={w === window}
              onClick={() => setWindow(w)}
            >
              {WINDOW_LABELS[w]}
            </button>
          ))}
        </div>
      </div>
      <Now report={current} health={health} latest={latest} nowMs={nowMs} />
      <div className="obs-observer__body">
        {error !== null && (
          <DataState
            kind="error"
            title="No se pudo leer la actividad"
            detail={
              current
                ? `${error}. Debajo queda la lectura anterior, no la actual.`
                : `${error}. No se muestra ningún valor anterior como actual.`
            }
          />
        )}
        {current ? (
          <>
            <Activity report={current} />
            <Results report={current} />
          </>
        ) : (
          error === null && <DataState kind="loading" />
        )}
        <section className="obs-card obs-history" aria-label="Historial">
          <p className="obs-card__label">Historial · decisiones del terminal</p>
          {children}
        </section>
        <details className="obs-details obs-details--panel">
          <summary>Limitaciones de esta lectura</summary>
          <ul>
            <li>
              Una ventana sin propuestas ni operaciones no es un error: las
              estrategias pueden no encontrar nada que hacer.
            </li>
            <li>
              Los minutos sin veredicto son la diferencia con la cadencia
              nominal de uno por minuto, no un diagnóstico de salud.
            </li>
            <li>
              Cada experimento tiene su propio ciclo: uno al día no prueba que
              los demás lo estén.
            </li>
            <li>
              Posiciones actuales: No disponible (B5); los registros abiertos
              del forward no son posiciones verificadas.
            </li>
            {current?.discards.state === 'ok' &&
              current.discards.notRecorded.map((text) => (
                <li key={text}>No se registra: {text}.</li>
              ))}
          </ul>
        </details>
      </div>
    </section>
  )
}
