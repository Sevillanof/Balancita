import type {
  IntelligenceStreamSnapshot,
  UseIntelligenceStreamResult,
} from './useIntelligenceStream.ts'
import './intelligence-status.css'

type Props = {
  readonly dataMode: 'real' | 'simulated'
  readonly stream: UseIntelligenceStreamResult
}

export default function IntelligenceStatusPanel({ dataMode, stream }: Props) {
  const snapshot = stream.snapshot
  const pipeline = snapshot?.pipeline
  const warnings = snapshot === null ? [] : warningsFor(snapshot)

  return (
    <section
      className="intelligence-status dashboard__surface"
      aria-labelledby="intelligence-status-title"
      aria-busy={stream.status === 'loading'}
    >
      <div className="section-header">
        <div>
          <p className="dashboard__eyebrow">Observabilidad</p>
          <h2 id="intelligence-status-title">Estado de inteligencia BTC-EUR</h2>
        </div>
        <div className="intelligence-status__badges" aria-live="polite">
          <span className="badge">
            Modo: {dataMode === 'real' ? 'Datos reales' : 'Datos simulados'}
          </span>
          {pipeline !== undefined && (
            <span className="badge">
              Pipeline: {pipelineLabel(pipeline.status)}
            </span>
          )}
          <span className="badge">
            {connectionLabel(stream.status, pipeline?.connection)}
          </span>
        </div>
      </div>

      {stream.status === 'loading' && (
        <p className="state" role="status">
          Conectando con el stream del servidor…
        </p>
      )}
      {stream.status === 'error' && (
        <p className="state state--error" role="alert">
          {stream.error?.message ??
            'No se pudo conectar con el stream del servidor.'}
        </p>
      )}
      {stream.status === 'disabled' && pipeline === undefined && (
        <p className="state state--warning" role="status">
          El navegador no tiene EventSource disponible; la observabilidad SSE
          está deshabilitada.
        </p>
      )}

      {snapshot !== null && (
        <>
          <p className="intelligence-status__message" role="status">
            {pipelineMessage(pipeline?.status)}
          </p>
          {warnings.length > 0 && (
            <ul
              className="intelligence-status__warnings"
              aria-label="Advertencias de inteligencia"
            >
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          {snapshot.market === null ? (
            <p className="state">
              Todavía no hay un snapshot de mercado disponible.
            </p>
          ) : (
            <dl className="intelligence-status__details">
              <div>
                <dt>Precio observado</dt>
                <dd>
                  €
                  {snapshot.market.price.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </dd>
              </div>
              <div>
                <dt>Edad de frescura</dt>
                <dd>
                  {snapshot.market.freshness.ageMs} ms
                  {snapshot.market.freshness.isStale ? ' · stale' : ''}
                </dd>
              </div>
              <div>
                <dt>Tiempo de evento (servidor)</dt>
                <dd>{formatServerTime(snapshot.market.eventTime)}</dd>
              </div>
              <div>
                <dt>Tiempo de recepción (servidor)</dt>
                <dd>{formatServerTime(snapshot.market.receivedTime)}</dd>
              </div>
              <div>
                <dt>Tiempo de display del snapshot (servidor)</dt>
                <dd>{formatServerTime(snapshot.market.displayTime)}</dd>
              </div>
              <div>
                <dt>Snapshot generado</dt>
                <dd>{formatServerTime(snapshot.generatedAt)}</dd>
              </div>
            </dl>
          )}

          <div
            className="intelligence-status__metrics"
            aria-label="Indicadores de servicio"
          >
            <Metric
              label="Latencia p50"
              value={formatMilliseconds(snapshot.observability?.latencyMs.p50)}
            />
            <Metric
              label="Latencia p95"
              value={formatMilliseconds(snapshot.observability?.latencyMs.p95)}
            />
            <Metric
              label="Stale rate"
              value={formatRate(snapshot.observability?.stale.rate)}
            />
            <Metric
              label="Gap rate"
              value={formatRate(snapshot.observability?.gaps.rate)}
            />
          </div>

          <div
            className="intelligence-status__summaries"
            aria-label="Resumen de inteligencia"
          >
            <Summary label="Análisis" value="no persistido" />
            <Summary
              label="Forecast"
              value={summaryLabel(snapshot.summaries.forecast)}
            />
            <Summary
              label="Noticias"
              value={summaryLabel(snapshot.summaries.news)}
            />
          </div>
        </>
      )}
    </section>
  )
}

function Metric({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Summary({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function warningsFor(snapshot: IntelligenceStreamSnapshot): readonly string[] {
  const warnings: string[] = []
  switch (snapshot.pipeline.status) {
    case 'disabled':
      warnings.push(
        'Colector deshabilitado: no está generando datos de mercado en el servidor.',
      )
      break
    case 'unavailable':
      warnings.push(
        'Colector o snapshot no disponible: no se muestran datos inventados.',
      )
      break
    case 'stale':
      warnings.push(
        'El último snapshot está stale; no se presenta como tiempo real.',
      )
      break
    case 'gap':
      warnings.push(
        'Se detectó un gap de secuencia; revisá la continuidad antes de interpretar el dato.',
      )
      break
    default:
      break
  }
  if (snapshot.market?.freshness.clockInverted === true)
    warnings.push(
      'El reloj del dato está invertido; la frescura no es confiable.',
    )
  if (
    snapshot.observability?.stale.rate !== null &&
    snapshot.observability?.stale.rate !== undefined &&
    snapshot.observability.stale.rate > 0 &&
    snapshot.pipeline.status !== 'stale'
  )
    warnings.push(
      'La ventana contiene snapshots stale; la tasa está expuesta y requiere cautela.',
    )
  return warnings
}

function pipelineLabel(
  status: IntelligenceStreamSnapshot['pipeline']['status'],
): string {
  switch (status) {
    case 'disabled':
      return 'Deshabilitado'
    case 'unavailable':
      return 'No disponible'
    case 'connecting':
      return 'Conectando'
    case 'ready':
      return 'Listo'
    case 'stale':
      return 'Stale'
    case 'gap':
      return 'Con gap'
  }
}

function pipelineMessage(
  status: IntelligenceStreamSnapshot['pipeline']['status'] | undefined,
): string {
  switch (status) {
    case 'disabled':
      return 'El colector de mercado está deshabilitado.'
    case 'unavailable':
      return 'No hay un snapshot de mercado disponible.'
    case 'connecting':
      return 'El colector de mercado está conectando.'
    case 'ready':
      return 'El pipeline de inteligencia está listo.'
    case 'stale':
      return 'El último snapshot de mercado está stale.'
    case 'gap':
      return 'El pipeline detectó un gap de secuencia.'
    default:
      return 'Sin estado de pipeline disponible.'
  }
}

function connectionLabel(
  status: UseIntelligenceStreamResult['status'],
  connection: IntelligenceStreamSnapshot['pipeline']['connection'] | undefined,
): string {
  if (status === 'loading') return 'Conectando'
  if (status === 'error') return 'Error de conexión'
  if (status === 'disabled')
    return connection === 'disabled' ? 'Deshabilitado' : 'SSE deshabilitado'
  switch (connection) {
    case 'connected':
      return 'Conectado'
    case 'connecting':
      return 'Conectando'
    case 'reconnecting':
      return 'Reconectando'
    case 'stale':
      return 'Conectado · stale'
    case 'unavailable':
      return 'No disponible'
    default:
      return 'Sin estado'
  }
}

function formatServerTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('es-AR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  })
}

function formatMilliseconds(value: number | null | undefined): string {
  return value === null || value === undefined ? 'No disponible' : `${value} ms`
}

function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined
    ? 'No disponible'
    : `${(value * 100).toFixed(1)}%`
}

function summaryLabel(
  summary:
    | IntelligenceStreamSnapshot['summaries']['forecast']
    | IntelligenceStreamSnapshot['summaries']['news'],
): string {
  if (summary.status === 'unavailable') return 'no disponible'
  if ('horizon' in summary)
    return `disponible · ${summary.horizon} · ${summary.id}`
  return `disponible · ${summary.relevantCount}/${summary.totalCount} relevantes`
}
