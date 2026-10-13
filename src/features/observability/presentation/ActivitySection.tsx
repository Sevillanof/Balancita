import {
  DataState,
  Metric,
  Panel,
} from '../../../shared/mission-control/index.ts'
import {
  ACTIVITY_WINDOWS,
  type ActivityReport,
  type ActivityWindow,
  type Section,
} from '../infrastructure/observability-api.ts'
import { momentLabel, shortProduct, sideLabel } from './format.ts'

const WINDOW_LABELS: Record<ActivityWindow, string> = {
  '3h': 'Últimas 3 h',
  '24h': 'Últimas 24 h',
}

/** A section the backend could not read: the reason, no figures. */
function Unavailable({ section }: { section: Section<object> }) {
  if (section.state !== 'unavailable') return null
  return (
    <DataState
      kind="unavailable"
      detail={`Origen ${section.evidence.origin ?? 'sin configurar'}: ${section.detail}`}
    />
  )
}

function Evaluations({ report }: { report: ActivityReport }) {
  const { evaluations } = report
  if (evaluations.state !== 'ok') return <Unavailable section={evaluations} />
  if (evaluations.byProduct.length === 0)
    return <DataState kind="nodata" detail="Sin productos en la respuesta." />
  return (
    <div className="obs-table-wrap">
      <table className="obs-table" data-testid="activity-products">
        <caption className="obs-sr">Evaluaciones por producto</caption>
        <thead>
          <tr>
            <th scope="col">Producto</th>
            <th scope="col">Veredictos</th>
            <th scope="col">Minutos sin veredicto</th>
            <th scope="col">Señales largo / corto</th>
            <th scope="col">Última señal</th>
          </tr>
        </thead>
        <tbody>
          {evaluations.byProduct.map((p) => (
            <tr key={p.product}>
              <th scope="row" data-label="Producto">
                {shortProduct(p.product)}
              </th>
              <td data-label="Veredictos">
                {p.count} de {p.expected}
              </td>
              <td data-label="Minutos sin veredicto">{p.missing}</td>
              <td data-label="Señales largo / corto">
                {p.long} / {p.short}
              </td>
              <td data-label="Última señal">
                {p.lastSignal
                  ? `${sideLabel(p.lastSignal.action)} · ${p.lastSignal.reasonCode} · ${momentLabel(p.lastSignal.bucketMs, report.generatedAtMs)}`
                  : 'Ninguna en la ventana'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Discards({ report }: { report: ActivityReport }) {
  const { discards } = report
  if (discards.state !== 'ok') return <Unavailable section={discards} />
  if (discards.byReason.length === 0)
    return <DataState kind="empty" title="Sin descartes en la ventana" />
  return (
    <>
      <ul className="obs-reasons" data-testid="activity-discards">
        {discards.byReason.map((r) => (
          <li key={`${r.action}|${r.reasonCode}`}>
            <code>{r.reasonCode}</code>
            <span className="obs-reasons__action">{r.action}</span>
            <span className="obs-reasons__count">{r.count}</span>
          </li>
        ))}
      </ul>
      {discards.truncated && (
        <p className="obs-note" data-testid="discards-truncated">
          Se muestran los {discards.byReason.length} motivos más frecuentes de{' '}
          {discards.distinctReasons}; los otros suman {discards.omittedCount}{' '}
          descartes. El total ({discards.total}) los incluye.
        </p>
      )}
    </>
  )
}

function Operations({ report }: { report: ActivityReport }) {
  const { operations } = report
  if (operations.state !== 'ok') return <Unavailable section={operations} />
  if (operations.experiments.length === 0)
    return (
      <DataState
        kind="empty"
        title="Sin experimentos del forward"
        detail="El forward no tiene estrategias que informar."
      />
    )
  return (
    <>
      <p className="obs-note">
        Origen de la lista: {operations.pairSource}. Solo se muestran
        operaciones que el forward ya almacenó; una señal o propuesta no es una
        operación.
      </p>
      <div className="obs-table-wrap">
        <table className="obs-table" data-testid="activity-experiments">
          <caption className="obs-sr">Actividad por experimento</caption>
          <thead>
            <tr>
              <th scope="col">Experimento</th>
              <th scope="col">Operaciones almacenadas en la ventana</th>
              <th scope="col">Última operación almacenada</th>
              <th scope="col">Registros abiertos (no verificados)</th>
              <th scope="col">Último ciclo del forward</th>
            </tr>
          </thead>
          <tbody>
            {operations.experiments.map((e) => (
              <tr key={e.experimentId}>
                <th scope="row" data-label="Experimento">
                  {e.experimentId}
                  <span className="obs-expected">
                    {e.expectedActive === true
                      ? 'Debe estar activo'
                      : e.expectedActive === false
                        ? 'Ya no se exige'
                        : 'Sin determinar si debe estar activo'}
                  </span>
                </th>
                <td data-label="Operaciones almacenadas en la ventana">
                  {e.tradesInWindow}
                </td>
                <td data-label="Última operación almacenada">
                  {e.lastTrade
                    ? `${shortProduct(e.lastTrade.product)} · ${sideLabel(e.lastTrade.side)} · entrada ${momentLabel(e.lastTrade.entryBucketMs, report.generatedAtMs)}${e.lastTrade.exitReason ? ` · salida: ${e.lastTrade.exitReason}` : ''}`
                    : 'Ninguna almacenada'}
                </td>
                <td data-label="Registros abiertos (no verificados)">
                  {e.openRecords}
                </td>
                <td data-label="Último ciclo del forward">
                  {momentLabel(e.lastCycleMs, report.generatedAtMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Limitations({ report }: { report: ActivityReport }) {
  const items: string[] = [
    'Una ventana sin señales ni operaciones no es un error: las estrategias pueden no encontrar nada que hacer. La salud está arriba (B1).',
    'Los minutos sin veredicto son la diferencia con la cadencia nominal de uno por minuto, no un diagnóstico: si el proceso de veredictos no se lanzó a propósito esos minutos no son un fallo.',
    'Los registros abiertos son lo último que el forward guardó, no posiciones actuales verificadas. Léelos junto con el último ciclo del forward.',
  ]
  // What the system does not record, as the backend lists it. Its other notes
  // restate the first three items above in field names, so they are not repeated.
  if (report.discards.state === 'ok')
    items.push(
      ...report.discards.notRecorded.map((text) => `No se registra: ${text}.`),
    )
  return (
    <div className="obs-limitations" data-testid="activity-limitations">
      <p className="obs-limitations__title">Limitaciones</p>
      <ul>
        {[...new Set(items)].map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  )
}

export default function ActivitySection({
  report,
  error,
  window,
  onWindow,
  product,
  products,
  onProduct,
}: {
  /** The read for exactly this window and product, or null while there is none. */
  report: ActivityReport | null
  /** The latest read failed. With a `report`, that report is an older read. */
  error: string | null
  window: ActivityWindow
  onWindow: (window: ActivityWindow) => void
  product: string | null
  products: readonly string[]
  onProduct: (product: string | null) => void
}) {
  return (
    <Panel
      eyebrow="B2 · solo lectura"
      title="Actividad verificable"
      label="Actividad verificable"
      actions={
        <div className="obs-controls">
          <div role="group" aria-label="Ventana de tiempo" className="obs-seg">
            {ACTIVITY_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={w === window}
                onClick={() => onWindow(w)}
              >
                {WINDOW_LABELS[w]}
              </button>
            ))}
          </div>
          <label className="obs-select">
            <span className="obs-sr">Producto</span>
            <select
              value={product ?? ''}
              onChange={(event) => onProduct(event.target.value || null)}
            >
              <option value="">Todos los productos</option>
              {products.map((p) => (
                <option key={p} value={p}>
                  {shortProduct(p)}
                </option>
              ))}
            </select>
          </label>
        </div>
      }
    >
      {error !== null && (
        <DataState
          kind="error"
          title="No se pudo leer la actividad"
          detail={
            report
              ? `${error}. Debajo queda la lectura anterior, no la actual.`
              : `${error}. No se muestra ningún valor anterior como actual.`
          }
        />
      )}
      {report ? (
        <ActivityContent report={report} />
      ) : (
        error === null && <DataState kind="loading" />
      )}
    </Panel>
  )
}

function ActivityContent({ report }: { report: ActivityReport }) {
  const { evaluations, signals, discards } = report
  return (
    <>
      <p className="obs-meta">
        Ventana: {momentLabel(report.fromMs, report.generatedAtMs)} →{' '}
        {momentLabel(report.toMs, report.generatedAtMs)}
      </p>
      <div className="obs-metrics">
        <Metric
          label="Veredictos (evaluaciones)"
          value={evaluations.state === 'ok' ? evaluations.total : 'Sin datos'}
        />
        <Metric
          label="Señales direccionales"
          value={signals.state === 'ok' ? signals.total : 'Sin datos'}
          hint={
            signals.state === 'ok'
              ? `${signals.long} largo · ${signals.short} corto. Propuestas, no órdenes.`
              : undefined
          }
        />
        <Metric
          label="Descartes"
          value={discards.state === 'ok' ? discards.total : 'Sin datos'}
          hint="Veredictos que esperaron o se abstuvieron"
        />
      </div>
      <h3 className="obs-subtitle">Evaluaciones y señales por producto</h3>
      <Evaluations report={report} />
      <h3 className="obs-subtitle">Motivos de espera y descarte</h3>
      <Discards report={report} />
      <h3 className="obs-subtitle">Experimentos del forward</h3>
      <Operations report={report} />
      <Limitations report={report} />
    </>
  )
}
