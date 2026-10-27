import { OBS } from './observability-styles.ts'
import { APPROVED_TERMINAL_STRATEGIES } from '../../../app/terminal-approved.ts'
import { useCallback, useState, type ReactNode } from 'react'
import { DataState, StatusPill } from '../../../shared/mission-control/index.ts'
import { TERMINAL_FRAME } from '../../../shared/design-system/terminal-styles.ts'
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
import {
  assessActuality,
  confirmedSourceEvidence,
  BLOCKER_TEXT,
  type GatewayClock,
  type HealthFreshness,
  type LatestDecision,
} from './latest-decision.ts'

const WINDOW_LABELS: Record<ActivityWindow, string> = {
  '3h': '3 h',
  '24h': '24 h',
}

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
function proposalsNote(decision: LatestDecision): string {
  const p = decision.proposals
  if (p === null) return 'El veredicto no trae el detalle de las propuestas.'
  if (p.total === 0)
    return 'El veredicto no registra propuestas de estrategias.'
  if (p.directional === 0)
    return p.total === 1
      ? 'La única propuesta registrada en el veredicto no fue LONG/SHORT.'
      : `Ninguna de las ${p.total} propuestas registradas en el veredicto fue LONG/SHORT.`
  return `${p.directional} de ${p.total} propuestas registradas fueron LONG/SHORT; el selector no abrió operación.`
}

function Now({
  report,
  health,
  product,
  latest: known,
  connected,
  connectedAtMs,
  clock,
  localNowMs,
}: {
  report: ActivityReport | null
  health: HealthRead & HealthFreshness
  product: string | null
  latest: LatestDecision | null
  connected: boolean
  connectedAtMs: number | null
  clock: GatewayClock | null
  localNowMs: number
}) {
  // «Ahora» needs more than a young timestamp: WebSocket connected, a valid
  // gateway clock and B1 evidence read on this connection that matches this
  // verdict. Anything less is «Sin confirmar», never a silent reuse.
  const actuality = known
    ? assessActuality({
        decision: known,
        product,
        connected,
        connectedAtMs,
        clock,
        health,
        localNowMs,
      })
    : null
  const standing = actuality?.standing ?? null
  const nowMs = actuality?.nowMs ?? localNowMs
  const latest = standing === 'current' ? known : null
  const unconfirmed = standing === 'unconfirmed' ? known : null
  const historic = standing === 'historic' ? known : null
  const clockNote = actuality?.gatewayClock ? 'hora del servidor' : 'hora local'
  // B1's reading for THIS product's verdict source, shown only while the read
  // passes the same freshness check as the decision above; else «Sin confirmar».
  const sourceRead = confirmedSourceEvidence({
    product,
    connected,
    connectedAtMs,
    clock,
    health,
    localNowMs,
  })
  const source = sourceRead.evidence
  const mine =
    report?.evaluations.state === 'ok' && report.product
      ? (report.evaluations.byProduct.find(
          (p) => p.product === report.product,
        ) ?? null)
      : null
  const windowLabel = report ? WINDOW_LABELS[report.window] : null
  return (
    <section className={OBS.now} aria-label="Ahora" data-testid="observer-now">
      <p className={OBS.nowLabel}>Ahora</p>
      <p className={OBS.big} data-testid="last-decision">
        Última decisión:{' '}
        {latest ? (
          <>
            <strong data-action={latest.action} data-testid="now-action">
              {decisionLabel(latest.action)}
            </strong>
            {latest.action === 'LONG' || latest.action === 'SHORT' ? (
              <small className={OBS.nowKind}> propuesta, no operación</small>
            ) : null}
          </>
        ) : unconfirmed ? (
          <strong data-testid="now-unconfirmed-label">Sin confirmar</strong>
        ) : (
          <span className={OBS.unavailable}>No disponible</span>
        )}
        <span className={OBS.pill} data-testid="source-health">
          <span className={OBS.pillLabel}>
            Salud de la fuente{product ? ` · ${shortProduct(product)}` : ''}
          </span>
          {source ? (
            <StatusPill tone={TONE[source.status]}>
              {LABEL[source.status]}
            </StatusPill>
          ) : sourceRead.confirmed ? (
            <span className={OBS.unavailable}>Sin datos</span>
          ) : (
            <span
              className={OBS.unavailable}
              data-testid="source-health-unconfirmed"
            >
              Sin confirmar
            </span>
          )}
        </span>
      </p>
      {unconfirmed && actuality && (
        <p
          className={OBS.summary}
          data-testid="now-unconfirmed"
          data-standing="unconfirmed"
        >
          Último veredicto recibido (no se presenta como estado actual):{' '}
          {decisionLabel(unconfirmed.action)}
          {unconfirmed.reasonCode ? (
            <>
              {' · '}
              <code>{unconfirmed.reasonCode}</code>
            </>
          ) : null}
          {' · '}
          {utcDateTime(unconfirmed.decisionTimeMs)} · hace{' '}
          {duration(nowMs - unconfirmed.decisionTimeMs)} ({clockNote})
          <small className={OBS.nowSource} data-testid="now-blockers">
            {' '}
            Falta confirmar:{' '}
            {actuality.blockers.map((b) => BLOCKER_TEXT[b]).join('; ')}.
          </small>
        </p>
      )}
      {latest && (
        <p
          className={OBS.summary}
          data-testid="now-detail"
          data-standing={standing}
        >
          {latest.reasonCode ? <code>{latest.reasonCode}</code> : 'Sin motivo'}
          {' · '}Régimen {latest.regime ?? 'No disponible'}
          {' · '}
          {utcDateTime(latest.decisionTimeMs)} · hace{' '}
          {duration(nowMs - latest.decisionTimeMs)} ({clockNote})
          <small className={OBS.nowSource} data-testid="now-source">
            {' '}
            Fuente: veredicto del flujo en vivo del gateway; no describe el
            estado del forward.
            {latest.action === 'WAIT'
              ? ` Espera: el selector no abrió operación; la causa es el motivo indicado. ${proposalsNote(latest)} Esperar no es un error.`
              : ''}
          </small>
        </p>
      )}
      {historic && (
        <p className={OBS.summary} data-testid="now-historic">
          Última decisión conocida (histórica, no es el estado actual):{' '}
          {decisionLabel(historic.action)}
          {historic.reasonCode ? (
            <>
              {' · '}
              <code>{historic.reasonCode}</code>
            </>
          ) : null}
          {' · '}
          {utcDateTime(historic.decisionTimeMs)} · hace{' '}
          {duration(nowMs - historic.decisionTimeMs)} ({clockNote})
          <small className={OBS.nowSource}>
            {' '}
            Fuente: veredicto guardado en el histórico del gateway; el flujo en
            vivo no entregó uno reciente.
          </small>
        </p>
      )}
      {report && mine && report.signals.state === 'ok' && (
        <p className={OBS.summary} data-testid="window-summary">
          Últimas {windowLabel} · {mine.count}{' '}
          {mine.count === 1 ? 'evaluación' : 'evaluaciones'} ·{' '}
          {report.signals.total}{' '}
          {report.signals.total === 1
            ? 'propuesta direccional'
            : 'propuestas direccionales'}
        </p>
      )}
      <details className={OBS.inlineDetails}>
        <summary>Qué fuentes respaldan esto</summary>
        <p className={OBS.note}>
          {latest
            ? 'La última decisión es la del último veredicto que el flujo en vivo del gateway entregó para este producto; solo se presenta como actual con la conexión WebSocket activa, la hora del servidor válida y una lectura reciente de B1 que coincide con ese veredicto. Los agregados de B2 no se usan para deducirla. '
            : 'Ninguna fuente verificable entrega la última decisión individual de este producto (llegará con B3). '}
          «Salud de la fuente» es la lectura de B1 de la fuente de decisiones
          para este producto; la salud global sigue en la cabecera.
        </p>
        <p className={OBS.note}>
          Última evaluación registrada:{' '}
          {report && mine?.lastBucketMs != null
            ? momentLabel(mine.lastBucketMs, report.generatedAtMs)
            : 'Sin datos'}
        </p>
      </details>
    </section>
  )
}

/** Only approved strategies get a row in the Terminal (Qwen has no book here). */
function shownBooks<T extends { experimentId: string }>(books: T[]): T[] {
  return books.filter((book) =>
    APPROVED_TERMINAL_STRATEGIES.includes(book.experimentId),
  )
}

function Results({ report }: { report: ActivityReport }) {
  const { operations } = report
  const stored =
    operations.state === 'ok'
      ? shownBooks(operations.experiments).reduce(
          (sum, e) => sum + e.tradesInWindow,
          0,
        )
      : null
  return (
    <section className={OBS.card} aria-label="Operaciones almacenadas">
      <p className={OBS.cardLabel}>
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
            <p className={OBS.note}>
              Sin entradas almacenadas en la ventana. Una propuesta no es una
              operación.
            </p>
          )}
          <ul className={OBS.experiments} data-testid="activity-experiments">
            {shownBooks(operations.experiments).map((e) => (
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
  connected,
  connectedAtMs,
  clock,
  localNowMs,
  glance,
  children,
}: {
  product: string | null
  health: HealthRead & HealthFreshness
  /** Last real analysis of the stream for this product, or null. */
  latest?: LatestDecision | null
  /** The Terminal's WebSocket is connected right now. */
  connected: boolean
  /** Browser time the current connection opened; null while disconnected. */
  connectedAtMs: number | null
  /** Gateway clock of the current connection, null when none arrived. */
  clock: GatewayClock | null
  /** This browser's clock, ticking: the staleness of every evidence. */
  localNowMs: number
  /** The at-a-glance strip (position, last look); shown first, outside the folded detail. */
  glance?: ReactNode
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
      className={`${TERMINAL_FRAME} ${OBS.observer}`}
      aria-label="Decisiones de Qwen"
      data-testid="activity-panel"
    >
      <div className={OBS.observerHead}>
        <h2>Decisiones de Qwen</h2>
        <div
          role="group"
          aria-label="Ventana de tiempo"
          className={OBS.segment}
        >
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
      {glance}
      <Now
        report={current}
        health={health}
        product={product}
        latest={latest}
        connected={connected}
        connectedAtMs={connectedAtMs}
        clock={clock}
        localNowMs={localNowMs}
      />
      <div className={OBS.observerBody}>
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
          <Results report={current} />
        ) : (
          error === null && <DataState kind="loading" />
        )}
        <section
          className={`${OBS.card} group/observer-history`}
          aria-label="Historial"
        >
          <p className={OBS.cardLabel}>Historial · decisiones del terminal</p>
          {children}
        </section>
        <details className={OBS.panelDetails}>
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
