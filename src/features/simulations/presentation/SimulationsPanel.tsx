import { useState } from 'react'
import EquityCurveChart from './EquityCurveChart.tsx'
import type {
  SimulationsBaselineMetrics,
  SimulationsCandidateRow,
  SimulationsComparisonReport,
  SimulationsEquityPoint,
  SimulationsProfitabilityEntry,
  SimulationsProfitabilityMetrics,
  SimulationsReportFile,
  SimulationsHistoryEntry,
  SimulationsStatus,
} from './simulations-types.ts'
import './simulations.css'

export const SIMULATIONS_GENERATE_COMMAND = 'pnpm --dir server simulations:run'

type SimulationsPanelProps = {
  readonly status: SimulationsStatus
  readonly file: SimulationsReportFile | null
  readonly error: Error | null
  readonly onRetry: () => void
  readonly onRefresh?: () => void
  readonly onSample?: (stage: 'smoke' | 'confirm', seed: number) => void
  readonly refreshing?: boolean
  readonly refreshError?: string | null
  readonly history?: readonly SimulationsHistoryEntry[]
  readonly historyStatus?: 'loading' | 'ready' | 'empty' | 'error'
  readonly historyError?: string | null
  readonly selectedHistoryId?: string | null
  readonly onSelectHistory?: (id: string) => void
}

/** Renders the persisted strategy-comparison report; read-only, BTC-EUR only. */
export default function SimulationsPanel({
  status,
  file,
  onRetry,
  onRefresh,
  onSample,
  refreshing = false,
  refreshError = null,
  history = [],
  historyStatus = 'empty',
  historyError = null,
  selectedHistoryId = null,
  onSelectHistory,
}: SimulationsPanelProps) {
  const [selectedHorizon, setSelectedHorizon] = useState<string | null>(null)
  const [seed, setSeed] = useState('1')
  const activeHorizon = file?.reports.some(
    (report) => report.horizon === selectedHorizon,
  )
    ? selectedHorizon
    : file?.reports[0]?.horizon
  return (
    <section className="simulations" aria-label="Simulaciones BTC-EUR">
      <div className="simulations__header">
        <p className="simulations__eyebrow">
          Comparación honesta de estrategias
        </p>
        <button
          type="button"
          className="button button--secondary"
          onClick={onRefresh}
          disabled={refreshing || onRefresh === undefined}
        >
          {refreshing ? 'Actualizando…' : 'Actualizar simulaciones'}
        </button>
        <label>
          Semilla visible
          <input
            type="number"
            min="0"
            step="1"
            aria-label="Semilla"
            inputMode="numeric"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button button--secondary"
          disabled={
            refreshing ||
            onSample === undefined ||
            !Number.isSafeInteger(Number(seed)) ||
            Number(seed) < 0 ||
            seed.trim() === ''
          }
          onClick={() => onSample?.('smoke', Number(seed))}
        >
          Prueba rápida (15m)
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={
            refreshing ||
            onSample === undefined ||
            !Number.isSafeInteger(Number(seed)) ||
            Number(seed) < 0 ||
            seed.trim() === ''
          }
          onClick={() => onSample?.('confirm', Number(seed))}
        >
          Confirmación (15m y 1h)
        </button>
      </div>
      {refreshError !== null && <p role="alert">{refreshError}</p>}
      <div className="simulations__history">
        <label htmlFor="simulations-history">Historial de simulaciones</label>
        {historyStatus === 'loading' && (
          <p role="status">Cargando historial…</p>
        )}
        {historyStatus === 'error' && (
          <p role="alert">
            {historyError ?? 'No se pudo cargar el historial.'}
          </p>
        )}
        {historyStatus === 'empty' && (
          <p role="status">Todavía no hay informes guardados.</p>
        )}
        {historyStatus === 'ready' && (
          <select
            id="simulations-history"
            aria-label="Historial de simulaciones"
            value={selectedHistoryId ?? ''}
            onChange={(event) => onSelectHistory?.(event.target.value)}
          >
            <option value="">Informe más reciente</option>
            {history.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {new Date(entry.generatedAt).toLocaleString('es-ES', {
                  timeZone: 'UTC',
                })}{' '}
                UTC ·{' '}
                {entry.sample === undefined
                  ? 'Ejecución completa'
                  : `${entry.sample.stage} · semilla ${entry.sample.seed}`}{' '}
                · datos {shortHash(entry.datasetHash)}
                {entry.window !== undefined &&
                  ` · ventana ${new Date(entry.window.since).toISOString().slice(0, 16)}–${new Date(entry.window.until).toISOString().slice(0, 16)} UTC`}
              </option>
            ))}
          </select>
        )}
      </div>

      {status === 'loading' && (
        <p role="status" aria-busy="true" className="simulations__state">
          Cargando simulaciones…
        </p>
      )}

      {status === 'error' && (
        <div
          role="alert"
          className="simulations__state simulations__state--error"
        >
          <span>No se pudieron cargar las simulaciones.</span>{' '}
          <button
            type="button"
            className="button button--secondary"
            onClick={onRetry}
          >
            Reintentar
          </button>
        </div>
      )}

      {status === 'empty' && (
        <p role="status" className="simulations__state">
          Aún no hay informe de simulaciones. Generá el informe con{' '}
          <code>{SIMULATIONS_GENERATE_COMMAND}</code> y volvé a abrir esta
          vista.
        </p>
      )}

      {status === 'ready' && file !== null && (
        <>
          <p role="status">
            Informe generado:{' '}
            {new Date(file.generatedAt).toLocaleString('es-ES', {
              timeZone: 'UTC',
            })}{' '}
            UTC · datos {shortHash(file.datasetHash)} · manifiesto{' '}
            {shortHash(file.manifestHash)}.
          </p>
          {file.sample !== undefined && (
            <p role="status">
              Etapa {file.sample.stage} · semilla {file.sample.seed} ·{' '}
              {new Date(file.sample.since).toISOString()} –{' '}
              {new Date(file.sample.until).toISOString()} · candidatas{' '}
              {file.sample.candidateIds.join(', ')} · horizontes{' '}
              {file.sample.horizons.join(', ')}.
            </p>
          )}
          <CoverageEvidence coverage={file.marketDataCoverage} />
          {file.reports.length > 1 && (
            <div role="tablist" aria-label="Horizonte de simulación">
              {file.reports.map((report) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={report.horizon === activeHorizon}
                  key={report.horizon}
                  onClick={() => setSelectedHorizon(report.horizon)}
                >
                  {report.horizon}
                </button>
              ))}
            </div>
          )}
          {file.reports
            .filter((report) => report.horizon === activeHorizon)
            .map((report) => (
              <article
                key={`${report.horizon}-${report.contentHash}`}
                aria-label={`Comparación en horizonte ${report.horizon}`}
              >
                <h3 className="simulations__horizon">
                  Horizonte {report.horizon} · BTC-EUR
                </h3>
                {report.winner !== null && (
                  <p className="simulations__winner" role="status">
                    Ganadora en selección: {report.winner.candidateId} (Brier{' '}
                    {formatMetric(report.winner.selectionBrier)}). Validación
                    única en el tramo bloqueado:{' '}
                    {formatMetric(report.winner.validationBrier)} sobre{' '}
                    {report.winner.validationCount} pronósticos.
                  </p>
                )}
                {report.profitability === null && (
                  <p className="simulations__state" role="status">
                    Sin bloque de rentabilidad: regenerá el informe con{' '}
                    <code>{SIMULATIONS_GENERATE_COMMAND}</code> para ver la
                    simulación de operaciones.
                  </p>
                )}
                <ul
                  className="simulations__grid"
                  aria-label={`Candidatas en horizonte ${report.horizon}`}
                >
                  {report.rows.map((row) => (
                    <li key={row.runId}>
                      <article
                        className="simulations__card"
                        aria-label={row.candidateId}
                      >
                        <CandidateCard row={row} report={report} />
                      </article>
                    </li>
                  ))}
                  <li>
                    <article
                      className="simulations__card simulations__card--baseline"
                      aria-label="Uniforme (base)"
                    >
                      <BaselineCard
                        title="Uniforme (base)"
                        metrics={report.baselines.uniform}
                        entry={report.profitability?.baselines.uniform ?? null}
                        report={report}
                      />
                    </article>
                  </li>
                  <li>
                    <article
                      className="simulations__card simulations__card--baseline"
                      aria-label="Sin cambio, comprar y mantener (base)"
                    >
                      <BaselineCard
                        title="Sin cambio · comprar y mantener (base)"
                        metrics={report.baselines.noChange}
                        entry={report.profitability?.baselines.noChange ?? null}
                        report={report}
                      />
                    </article>
                  </li>
                  <li>
                    <article
                      className="simulations__card simulations__card--baseline"
                      aria-label="Momentum (base)"
                    >
                      <BaselineCard
                        title="Momentum (base)"
                        metrics={report.baselines.momentum}
                        entry={report.profitability?.baselines.momentum ?? null}
                        report={report}
                      />
                    </article>
                  </li>
                  {report.profitability?.baselines.flatCash !== undefined && (
                    <li>
                      <article
                        className="simulations__card simulations__card--baseline"
                        aria-label="Efectivo sin operar (base)"
                      >
                        <FlatCashCard
                          entry={report.profitability.baselines.flatCash}
                          report={report}
                        />
                      </article>
                    </li>
                  )}
                </ul>
                {report.microCandidateDiagnostics !== null &&
                  report.microCandidateDiagnostics !== undefined &&
                    // prettier-ignore
                    <section aria-label="Validación experimental de estrategias micro">
                    <h4>Validación experimental · candidatas micro</h4>
                    <p>{report.microCandidateDiagnostics.holdoutNotice}</p>
                    {report.microCandidateDiagnostics.version === 'micro-candidate-diagnostics.v2' ? (
                      <>
                        <p>
                          Comparabilidad predictiva: selección {report.microCandidateDiagnostics.selectionStatus} ({report.microCandidateDiagnostics.selectionEligibleCount} instantes compartidos) · validación {report.microCandidateDiagnostics.validationStatus} ({report.microCandidateDiagnostics.validationEligibleCount} instantes compartidos).
                        </p>
                        <p>{report.microCandidateDiagnostics.computabilityNotice}</p>
                      </>
                    ) : (
                      <p>
                        Informe histórico: no registra los instantes elegibles compartidos; la comparabilidad predictiva no se puede reconstruir.
                      </p>
                    )}
                    <div className="table-scroll">
                      <table className="data-table">
                        <caption>Resultados del mismo tramo de validación; no usar para ajustar reglas</caption>
                        <thead><tr><th>Candidata/base</th><th>Muestras</th><th>Brier</th><th>Órdenes / ciclos cerrados</th><th>Retorno neto</th><th>Drawdown</th></tr></thead>
                        <tbody>
                          {report.microCandidateDiagnostics.candidates.map((item) => (
                            <tr key={item.candidateId}>
                              <th scope="row">{item.candidateId}</th>
                              <td>{item.validationMaturedCount} · previo {item.priorReadyCount}/{item.forecastOrigins}</td>
                              <td>{formatMetric(item.validationBrier)} (selección {formatMetric(item.selectionBrier)})</td>
                              <td>{item.validationFillCount} / {item.validationRoundTripCount}</td>
                              <td>{formatPercent(item.validationNetReturnPct / 100)}</td>
                              <td>{formatPercent(item.validationDrawdownPct / 100)}</td>
                            </tr>
                          ))}
                          {(['uniform', 'noChange', 'momentum'] as const).map((key) => (
                            (() => {
                              const tradeMetrics = report.profitability?.baselines[key].validation.metrics
                              return <tr key={key}>
                                <th scope="row">{key === 'uniform' ? 'Uniforme' : key === 'noChange' ? 'Sin cambio' : 'Momentum'}</th>
                                <td>{report.microCandidateDiagnostics!.validationBaselines[key].count}</td>
                                <td>{formatMetric(report.microCandidateDiagnostics!.selectionBaselines[key].brier)} / {formatMetric(report.microCandidateDiagnostics!.validationBaselines[key].brier)}</td>
                                <td>{tradeMetrics?.fillCount ?? 0} / {tradeMetrics?.tradeCount ?? 0}</td>
                                <td>{tradeMetrics === undefined ? '—' : formatPercent(tradeMetrics.netReturnPct / 100)}</td>
                                <td>{tradeMetrics === undefined ? '—' : formatPercent(tradeMetrics.maxDrawdownPct / 100)}</td>
                              </tr>
                            })()
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>}
                <footer className="simulations__provenance">
                  <p>
                    Procedencia: conjunto {shortHash(report.datasetHash)} ·
                    manifiesto {shortHash(report.manifestHash)} · selección{' '}
                    {Math.round(report.selectionPct * 100)}% (
                    {report.selectionCount} selección / {report.validationCount}{' '}
                    validación).
                  </p>
                  {report.profitability !== null && (
                    <p>
                      Regla {report.profitability.ruleVersion} · costos{' '}
                      {report.profitability.costsVersion} (comisión{' '}
                      {formatRate(report.profitability.costs.commissionRate)} ·
                      deslizamiento{' '}
                      {formatRate(report.profitability.costs.slippageRate)}) ·
                      capital {formatCash(report.profitability.startingCash)} ·
                      entrada {formatRate(report.profitability.entryThreshold)}{' '}
                      / salida{' '}
                      {formatRate(report.profitability.exitUpThreshold)}.
                    </p>
                  )}
                  {report.profitability?.feeScenario !== undefined && (
                    <p>
                      Escenario estimado de comisión:{' '}
                      {report.profitability.feeScenario.venue} ·{' '}
                      {report.profitability.feeScenario.pair} ·{' '}
                      {report.profitability.feeScenario.tier} ·{' '}
                      {report.profitability.feeScenario.role} por lado ·
                      comisión{' '}
                      {formatRate(
                        report.profitability.feeScenario.commissionRate,
                      )}
                      . Cuenta/tier real: desconocido; no representa una tarifa
                      ni ejecución real. Fuente verificada el{' '}
                      {report.profitability.feeScenario.verifiedAt}:{' '}
                      <a href={report.profitability.feeScenario.sourceUrl}>
                        {report.profitability.feeScenario.sourceUrl}
                      </a>
                    </p>
                  )}
                  {report.profitability !== null &&
                    report.profitability.feeScenario === undefined && (
                      <p>
                        Informe histórico: la procedencia del escenario de
                        comisión no está registrada.
                      </p>
                    )}
                  {file.window !== undefined && (
                    <p>
                      Ventana UTC: {new Date(file.window.since).toISOString()} –{' '}
                      {new Date(file.window.until).toISOString()}.
                    </p>
                  )}
                  <ul aria-label="Identificadores de ejecución">
                    {report.rows.map((row) => (
                      <li key={row.runId}>{row.runId}</li>
                    ))}
                  </ul>
                </footer>
              </article>
            ))}
          <aside aria-label="Limitaciones" className="simulations__limits">
            <ul>
              {(file.reports[0]?.limitations ?? []).map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
            <p className="simulations__disclaimer">
              Contenido educativo e informativo: es una simulación, no es
              asesoramiento financiero y no ejecuta órdenes.
            </p>
          </aside>
        </>
      )}
    </section>
  )
}

function CoverageEvidence({
  coverage,
}: {
  readonly coverage: SimulationsReportFile['marketDataCoverage']
}) {
  if (coverage === undefined)
    return (
      <p role="status">
        Este informe histórico no incluye cobertura de fuentes.
      </p>
    )

  const observation = coverage.observations
  const ohlc = coverage.ohlc
  return (
    <details className="simulations__provenance">
      <summary>Cobertura de datos al momento de la medición</summary>
      <p>Medición: {new Date(coverage.measuredAt).toISOString()}.</p>
      <p>
        Los estados de frescura pertenecen a esta instantánea y no describen la
        frescura actual.
      </p>
      <p>
        La cobertura global de la base de datos se mide al momento de la
        medición; no corresponde a la ventana evaluada en este informe.
      </p>
      <p>
        Los informes del simulador usan observaciones de mercado; Fast Replay
        usa velas REST OHLC. Son fuentes distintas.
      </p>
      <p>
        La suficiencia de la estrategia se mide con operaciones cerradas en cada
        tramo, no con el número de observaciones.
      </p>
      <dl>
        <div>
          <dt>{observation.source}</dt>
          <dd>
            {observation.count} observaciones · evento{' '}
            {formatCoverageTime(observation.firstEventTime)} –{' '}
            {formatCoverageTime(observation.lastEventTime)} · recepción máxima{' '}
            {formatCoverageTime(observation.maxReceivedTime)} · antigüedad{' '}
            {formatAge(observation.ageMs)} · frescura{' '}
            {observation.freshnessStatus} al momento de la medición · intervalo{' '}
            {observation.spanAdequacy} · integridad de observaciones{' '}
            {observation.completeness} · suficiencia global{' '}
            {observation.coverageAdequacy}.{' Huecos: no medidos. '}
            {observation.gaps.reason}
            {observation.reason === null ? '' : ` ${observation.reason}`}
          </dd>
        </div>
        <div>
          <dt>{ohlc.source}</dt>
          <dd>
            {ohlc.count} velas de 1 minuto · cierre/evento{' '}
            {formatCoverageTime(ohlc.firstEventTime)} –{' '}
            {formatCoverageTime(ohlc.lastEventTime)} · antigüedad{' '}
            {formatAge(ohlc.ageMs)} · huecos{' '}
            {ohlc.gapCount === null ? 'no medidos' : ohlc.gapCount} · frescura{' '}
            {ohlc.freshnessStatus} al momento de la medición · intervalo{' '}
            {ohlc.spanAdequacy} · continuidad/suficiencia{' '}
            {ohlc.coverageAdequacy}.
            {ohlc.reason === null ? '' : ` ${ohlc.reason}`}
          </dd>
        </div>
      </dl>
    </details>
  )
}

function formatCoverageTime(value: number | null): string {
  return value === null ? 'sin datos' : new Date(value).toISOString()
}

function formatAge(value: number | null): string {
  return value === null
    ? 'no disponible'
    : `${value.toLocaleString('es-ES')} ms`
}

function CandidateCard({
  row,
  report,
}: {
  readonly row: SimulationsCandidateRow
  readonly report: SimulationsComparisonReport
}) {
  const entry =
    report.profitability?.candidates.find(
      (candidate) => candidate.candidateId === row.candidateId,
    ) ?? null
  return (
    <>
      <h4 className="simulations__card-title">{row.candidateId}</h4>
      <p className="simulations__card-rule">
        {row.ruleVersion} · {row.paramSetVersion}
      </p>
      <dl className="simulations__metrics">
        <div>
          <dt>Cobertura</dt>
          <dd>{formatPercent(row.coverage)}</dd>
        </div>
        <div>
          <dt>Brier</dt>
          <dd>
            {formatMetric(row.brier)} / validación{' '}
            {formatMetric(row.validationBrier)}
          </dd>
        </div>
      </dl>
      {entry !== null && (
        <ProfitabilityDetails
          entry={entry}
          baselineValidation={
            report.profitability?.buyAndHoldEquity.validation ?? []
          }
        />
      )}
    </>
  )
}

function BaselineCard({
  title,
  metrics,
  entry,
  report,
}: {
  readonly title: string
  readonly metrics: SimulationsBaselineMetrics
  readonly entry: SimulationsProfitabilityEntry | null
  readonly report: SimulationsComparisonReport
}) {
  return (
    <>
      <h4 className="simulations__card-title">{title}</h4>
      <dl className="simulations__metrics">
        <div>
          <dt>Brier</dt>
          <dd>{formatMetric(metrics.brier)}</dd>
        </div>
      </dl>
      {entry !== null && (
        <ProfitabilityDetails
          entry={entry}
          baselineValidation={
            report.profitability?.buyAndHoldEquity.validation ?? []
          }
        />
      )}
    </>
  )
}

function FlatCashCard({
  entry,
  report,
}: {
  readonly entry: SimulationsProfitabilityEntry
  readonly report: SimulationsComparisonReport
}) {
  return (
    <>
      <h4 className="simulations__card-title">Efectivo sin operar (base)</h4>
      <p>Capital constante; cero órdenes y sin comisiones ni deslizamiento.</p>
      <ProfitabilityDetails
        entry={entry}
        baselineValidation={
          report.profitability?.buyAndHoldEquity.validation ?? []
        }
      />
    </>
  )
}

function ProfitabilityDetails({
  entry,
  baselineValidation,
}: {
  readonly entry: SimulationsProfitabilityEntry
  readonly baselineValidation: readonly SimulationsEquityPoint[]
}) {
  return (
    <>
      <EquityCurveChart
        candidate={entry.validation.equityCurve}
        baseline={baselineValidation}
        label="Validación"
      />
      <div className="simulations__slices">
        <section aria-label="Selección">
          <h5 className="simulations__slice-title">Selección</h5>
          <ProfitabilityMetrics metrics={entry.selection.metrics} />
        </section>
        <section aria-label="Validación" className="simulations__slice--main">
          <h5 className="simulations__slice-title">Validación</h5>
          <ProfitabilityMetrics metrics={entry.validation.metrics} />
          {entry.validation.readiness !== undefined && (
            <p role="status">
              {entry.validation.readiness.status === 'insufficient'
                ? 'Evidencia insuficiente'
                : 'Pendiente de revisión'}
              : Ventana evaluada:{' '}
              {entry.validation.readiness.windowDays.toFixed(1)} días.{' '}
              {entry.validation.readiness.reasons.join(' ')}
            </p>
          )}
        </section>
      </div>
      <p className="simulations__chart-legend">
        Curva: candidata frente a comprar y mantener en validación.
      </p>
    </>
  )
}

function ProfitabilityMetrics({
  metrics,
}: {
  readonly metrics: SimulationsProfitabilityMetrics
}) {
  return (
    <dl className="simulations__metrics">
      <div>
        <dt>Rentabilidad neta</dt>
        <dd>{formatSignedPercent(metrics.netReturnPct)}</dd>
      </div>
      <div>
        <dt>Operaciones</dt>
        <dd>{metrics.tradeCount}</dd>
      </div>
      {metrics.fillCount !== undefined && (
        <div>
          <dt>Ejecuciones</dt>
          <dd>{metrics.fillCount}</dd>
        </div>
      )}
      <div>
        <dt>Aciertos</dt>
        <dd>{formatPercent(metrics.winRate)}</dd>
      </div>
      <div>
        <dt>Profit Factor</dt>
        <dd>{formatMetric(metrics.profitFactor ?? null)}</dd>
      </div>
      <div>
        <dt>Retroceso máximo</dt>
        <dd>{formatSignedPercent(metrics.maxDrawdownPct)}</dd>
      </div>
      <div>
        <dt>Exposición</dt>
        <dd>{formatPercent(metrics.exposurePct)}</dd>
      </div>
    </dl>
  )
}

function formatMetric(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toFixed(4)
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function formatCash(value: number): string {
  return `${value.toLocaleString('es-ES')} EUR`
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash
}
