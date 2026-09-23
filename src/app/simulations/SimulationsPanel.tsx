import type {
  SimulationsCandidateRow,
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
              <div className="table-scroll">
                <table className="simulations__table">
                  <caption>
                    Comparación de estrategias ordenada por Brier ascendente; la
                    métrica principal es Brier, la precisión es secundaria.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Candidata</th>
                      <th scope="col">Regla</th>
                      <th scope="col">Parámetros</th>
                      <th scope="col">Cobertura</th>
                      <th scope="col">Brier</th>
                      <th scope="col">Calibración</th>
                      <th scope="col">Selección vs. validación</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <RowCells key={row.runId} row={row} />
                    ))}
                    <tr className="simulations__baseline">
                      <th scope="row">Uniforme (base)</th>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                      <td>{formatMetric(report.baselines.uniform.brier)}</td>
                      <td>—</td>
                      <td>—</td>
                    </tr>
                    <tr className="simulations__baseline">
                      <th scope="row">Sin cambio (base)</th>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                      <td>{formatMetric(report.baselines.noChange.brier)}</td>
                      <td>—</td>
                      <td>—</td>
                    </tr>
                    <tr className="simulations__baseline">
                      <th scope="row">Momentum (base)</th>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                      <td>{formatMetric(report.baselines.momentum.brier)}</td>
                      <td>—</td>
                      <td>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <footer className="simulations__provenance">
                <p>
                  Procedencia: conjunto {shortHash(report.datasetHash)} ·
                  manifiesto {shortHash(report.manifestHash)} · selección{' '}
                  {Math.round(report.selectionPct * 100)}% (
                  {report.selectionCount} selección / {report.validationCount}{' '}
                  validación).
                </p>
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
              Contenido educativo e informativo: no es asesoramiento financiero
              y no ejecuta órdenes.
            </p>
          </aside>
        </>
      )}
    </section>
  )
}

function RowCells({ row }: { readonly row: SimulationsCandidateRow }) {
  return (
    <tr>
      <th scope="row">{row.candidateId}</th>
      <td>{row.ruleVersion}</td>
      <td>{row.paramSetVersion}</td>
      <td>{formatPercent(row.coverage)}</td>
      <td>{formatMetric(row.brier)}</td>
      <td>{formatCalibration(row)}</td>
      <td>
        {formatMetric(row.brier)} vs. {formatMetric(row.validationBrier)}
      </td>
    </tr>
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

function formatCalibration(row: SimulationsCandidateRow): string {
  const bands = row.calibration.filter(
    (band) =>
      band.count > 0 &&
      band.meanPredictedProbability !== null &&
      band.observedFrequency !== null,
  )
  if (bands.length === 0) return '—'
  const gap =
    bands.reduce(
      (sum, band) =>
        sum +
        Math.abs(band.meanPredictedProbability! - band.observedFrequency!),
      0,
    ) / bands.length
  return `desvío ${gap.toFixed(3)} (${bands.length} bandas)`
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash
}
