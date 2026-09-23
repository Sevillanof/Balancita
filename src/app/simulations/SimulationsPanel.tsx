import EquityCurveChart from './EquityCurveChart'
import type {
  SimulationsBaselineMetrics,
  SimulationsCandidateRow,
  SimulationsComparisonReport,
  SimulationsEquityPoint,
  SimulationsProfitabilityEntry,
  SimulationsProfitabilityMetrics,
  SimulationsReportFile,
  SimulationsStatus,
} from './simulations-types'
import './simulations.css'

export const SIMULATIONS_GENERATE_COMMAND = 'pnpm --dir server simulations:run'

type SimulationsPanelProps = {
  readonly status: SimulationsStatus
  readonly file: SimulationsReportFile | null
  readonly error: Error | null
  readonly onRetry: () => void
}

/** Renders the persisted strategy-comparison report; read-only, BTC-EUR only. */
export default function SimulationsPanel({
  status,
  file,
  onRetry,
}: SimulationsPanelProps) {
  return (
    <section className="simulations" aria-label="Simulaciones BTC-EUR">
      <p className="simulations__eyebrow">Comparación honesta de estrategias</p>

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
          {file.reports.map((report) => (
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
              </ul>
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
                    entrada {formatRate(report.profitability.entryThreshold)} /
                    salida {formatRate(report.profitability.exitUpThreshold)}.
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
      <div>
        <dt>Aciertos</dt>
        <dd>{formatPercent(metrics.winRate)}</dd>
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
