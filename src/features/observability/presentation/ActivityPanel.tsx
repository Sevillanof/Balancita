import { useCallback, useState } from 'react'
import './observability.css'
import { DataState, Metric } from '../../../shared/mission-control/index.ts'
import {
  ACTIVITY_WINDOWS,
  fetchActivity,
  type ActivityReport,
  type ActivityWindow,
  type Section,
} from '../infrastructure/observability-api.ts'
import { useReport } from '../infrastructure/useReport.ts'
import { momentLabel, shortProduct, sideLabel } from './format.ts'

const WINDOW_LABELS: Record<ActivityWindow, string> = {
  '3h': '3 h',
  '24h': '24 h',
}
const TOP_REASONS = 5

function Unavailable({ section }: { section: Section<object> }) {
  if (section.state !== 'unavailable') return null
  return (
    <DataState
      kind="unavailable"
      detail={`Origen ${section.evidence.origin ?? 'sin configurar'}: ${section.detail}`}
    />
  )
}

function Content({ report }: { report: ActivityReport }) {
  const { evaluations, signals, discards, operations } = report
  // The figures of this product only: with no product there is no "mine".
  const mine =
    evaluations.state === 'ok' && report.product
      ? (evaluations.byProduct.find((p) => p.product === report.product) ??
        null)
      : null
  const top = discards.state === 'ok' ? discards.byReason[0] : undefined
  const stored =
    operations.state === 'ok'
      ? operations.experiments.reduce((sum, e) => sum + e.tradesInWindow, 0)
      : null
  const lastCycle =
    operations.state === 'ok'
      ? operations.experiments.reduce<number | null>(
          (best, e) =>
            e.lastCycleMs === null
              ? best
              : best === null
                ? e.lastCycleMs
                : Math.max(best, e.lastCycleMs),
          null,
        )
      : null
  return (
    <>
      <section className="obs-card" aria-label="Decisión del motor">
        <p className="obs-card__label">Decisión del motor</p>
        {evaluations.state !== 'ok' || signals.state !== 'ok' ? (
          <DataState kind="nodata" detail="Sin lectura de veredictos." />
        ) : (
          <>
            <p className="obs-card__big" data-testid="engine-state">
              {signals.total === 0
                ? 'Esperando: sin señales en la ventana'
                : `${signals.total} señal${signals.total === 1 ? '' : 'es'} en la ventana`}
            </p>
            <p className="obs-note">
              {mine?.lastBucketMs != null
                ? `Última evaluación: ${momentLabel(mine.lastBucketMs, report.generatedAtMs)}. `
                : 'Sin evaluaciones en la ventana. '}
              {top
                ? `Motivo principal de espera: ${top.reasonCode} (${top.count}×). `
                : ''}
              Esperar es un comportamiento normal; la salud técnica está en el
              indicador de la cabecera.
            </p>
          </>
        )}
      </section>

      <section className="obs-card" aria-label="Actividad de la ventana">
        <p className="obs-card__label">
          Actividad · {report.product ? shortProduct(report.product) : 'todos'}
        </p>
        <div className="obs-metrics">
          <Metric
            label="Veredictos"
            value={
              mine
                ? `${mine.count} / ${mine.expected}`
                : evaluations.state === 'ok'
                  ? evaluations.total
                  : 'Sin datos'
            }
            hint={
              mine
                ? `${mine.missing} min sin veredicto frente a 1 por minuto`
                : undefined
            }
          />
          <Metric
            label="Señales"
            value={signals.state === 'ok' ? signals.total : 'Sin datos'}
            hint={
              signals.state === 'ok'
                ? `${signals.long} largo · ${signals.short} corto. Propuestas, no operaciones.`
                : undefined
            }
          />
        </div>
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

      <section className="obs-card" aria-label="Operaciones almacenadas">
        <p className="obs-card__label">
          Operaciones almacenadas en la ventana
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
                Ningún experimento almacenó una entrada en la ventana. Una señal
                no es una operación.
              </p>
            )}
            <ul className="obs-exps" data-testid="activity-experiments">
              {operations.experiments.map((e) => (
                <li key={e.experimentId}>
                  <strong>{e.experimentId}</strong>
                  <span>
                    {e.lastTrade
                      ? `${shortProduct(e.lastTrade.product)} ${sideLabel(e.lastTrade.side).toLowerCase()}${e.lastTrade.exitReason ? ` · salida ${e.lastTrade.exitReason}` : ''} · ${momentLabel(e.lastTrade.entryBucketMs, report.generatedAtMs)}`
                      : 'Ninguna almacenada'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="obs-note">
              {lastCycle === null
                ? 'Último ciclo del forward: sin datos. '
                : `Último ciclo del forward: ${momentLabel(lastCycle, report.generatedAtMs)}. `}
              Posiciones actuales: No disponible (se verificarán con B5); los
              registros abiertos del forward no son posiciones verificadas.
            </p>
          </>
        )}
      </section>

      <section className="obs-card" aria-label="Línea temporal agrupada">
        <p className="obs-card__label">
          Línea temporal agrupada
          <span className="obs-na">Requiere B3</span>
        </p>
      </section>

      <details className="obs-details obs-details--panel">
        <summary>Limitaciones de esta lectura</summary>
        <ul>
          <li>
            Una ventana sin señales ni operaciones no es un error: las
            estrategias pueden no encontrar nada que hacer.
          </li>
          <li>
            Los minutos sin veredicto son la diferencia con la cadencia nominal
            de uno por minuto, no un diagnóstico de salud.
          </li>
          {discards.state === 'ok' &&
            discards.notRecorded.map((text) => (
              <li key={text}>No se registra: {text}.</li>
            ))}
        </ul>
      </details>
    </>
  )
}

/**
 * Right-hand panel of the Terminal: what the engine did in the last 3 or 24
 * hours for this product, from B2. It never turns a proposal into an
 * execution nor a stored record into a verified position.
 */
export default function ActivityPanel({ product }: { product: string | null }) {
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
      className="demo-terminal__panel obs-activity"
      aria-label="Actividad del motor"
      data-testid="activity-panel"
    >
      <div className="obs-activity__head">
        <h2>Actividad del motor</h2>
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
      <div className="obs-activity__body">
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
          <Content report={current} />
        ) : (
          error === null && <DataState kind="loading" />
        )}
      </div>
    </section>
  )
}
