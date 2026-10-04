import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { validateHistoricalRequest } from './validation.ts'
import {
  HISTORICAL_INTERVALS,
  HISTORICAL_STRATEGIES,
  type HistoricalProvider,
  type HistoricalRequest,
  type HistoricalResult,
} from './types.ts'
import './historical.css'
import HistoricalWorkbench from '../../trading-view/presentation/HistoricalWorkbench.tsx'
import {
  HistoricalMetricCards,
  HistoricalPanel,
  HistoricalTable,
} from '../../trading-view/presentation/HistoricalPresentationSlots.tsx'

type Props = { provider: HistoricalProvider }

const initialRequest: HistoricalRequest = {
  asset: 'BTC/EUR',
  from: '2026-08-01',
  to: '2026-09-30',
  interval: '15m',
  strategy: HISTORICAL_STRATEGIES[0],
  capital: 10_000,
}
const money = (value: number) =>
  new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)

export default function HistoricalView({ provider }: Props) {
  const [form, setForm] = useState(initialRequest)
  const [result, setResult] = useState<HistoricalResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const equityPath = useMemo(() => makePath(result?.equity ?? []), [result])

  useEffect(() => () => controller.current?.abort(), [])

  const update = <K extends keyof HistoricalRequest>(
    key: K,
    value: HistoricalRequest[K],
  ) => setForm((current) => ({ ...current, [key]: value }))

  const execute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const submitted = Object.freeze({ ...form })
    const validationError = validateHistoricalRequest(submitted)
    if (validationError) {
      setError(validationError)
      setResult(null)
      return
    }
    controller.current?.abort()
    const activeController = new AbortController()
    controller.current = activeController
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const response = await provider.run(submitted, activeController.signal)
      if (
        !activeController.signal.aborted &&
        controller.current === activeController
      )
        setResult(response)
    } catch (reason) {
      if (
        !activeController.signal.aborted &&
        controller.current === activeController
      )
        setError(
          reason instanceof Error
            ? 'No se pudo generar el ejemplo. Inténtalo de nuevo.'
            : 'Ocurrió un error al generar el ejemplo.',
        )
    } finally {
      if (controller.current === activeController) {
        controller.current = null
        setLoading(false)
      }
    }
  }

  return (
    <section className="demo-history" aria-label="Pruebas históricas demo">
      <div className="demo-history__intro">
        <div>
          <p className="demo-shell__eyebrow">LABORATORIO / 02</p>
          <p>
            Explora un escenario reproducible antes de conectar datos históricos
            reales.
          </p>
        </div>
        <span className="demo-history__badge">
          SIMULACIÓN DE EJEMPLO · NO VALIDADA
        </span>
      </div>
      <HistoricalWorkbench
        form={
          <form
            className="demo-history__panel demo-history__form"
            onSubmit={execute}
          >
            <h2>
              <span aria-hidden="true">◈</span> Configuración
            </h2>
            <label>
              Activo
              <select
                value={form.asset}
                onChange={(event) =>
                  update(
                    'asset',
                    event.target.value as HistoricalRequest['asset'],
                  )
                }
              >
                <option value="BTC/EUR">BTC/EUR</option>
              </select>
            </label>
            <div className="demo-history__dates">
              <label>
                Desde
                <input
                  type="date"
                  value={form.from}
                  onChange={(event) => update('from', event.target.value)}
                />
              </label>
              <label>
                Hasta
                <input
                  type="date"
                  value={form.to}
                  onChange={(event) => update('to', event.target.value)}
                />
              </label>
            </div>
            <label>
              Intervalo
              <select
                value={form.interval}
                onChange={(event) =>
                  update(
                    'interval',
                    event.target.value as HistoricalRequest['interval'],
                  )
                }
              >
                {HISTORICAL_INTERVALS.map((interval) => (
                  <option key={interval} value={interval}>
                    {interval === '1h'
                      ? '1 hora'
                      : `${interval.slice(0, -1)} ${interval === '1m' ? 'minuto' : 'minutos'}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Estrategia (etiqueta ilustrativa)
              <select
                value={form.strategy}
                onChange={(event) =>
                  update(
                    'strategy',
                    event.target.value as HistoricalRequest['strategy'],
                  )
                }
              >
                {HISTORICAL_STRATEGIES.map((strategy) => (
                  <option key={strategy}>{strategy}</option>
                ))}
              </select>
            </label>
            <label>
              Capital inicial (EUR)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.capital}
                onChange={(event) =>
                  update(
                    'capital',
                    event.target.value === ''
                      ? Number.NaN
                      : Number(event.target.value),
                  )
                }
              />
            </label>
            {error && (
              <p className="demo-history__error" role="alert">
                {error}
              </p>
            )}
            <button
              className="demo-history__submit"
              type="submit"
              disabled={loading}
            >
              {loading ? 'Generando ejemplo…' : 'Ejecutar simulación　→'}
            </button>
            <p className="demo-history__disclaimer">
              Los resultados son cálculos locales sobre operaciones sintéticas.
              No son un backtest real ni prueban rentabilidad futura.
            </p>
          </form>
        }
        results={
          <>
            {!result && (
              <div
                className="demo-history__panel demo-history__empty"
                role={loading ? 'status' : undefined}
                aria-busy={loading || undefined}
              >
                <span aria-hidden="true">◈</span>
                <h2>
                  {loading ? 'Generando simulación…' : 'Sin resultados todavía'}
                </h2>
                <p>
                  {loading
                    ? 'Preparando un escenario demostrativo.'
                    : 'Configura los parámetros y ejecuta una simulación para ver la curva y sus métricas.'}
                </p>
              </div>
            )}
            {result && (
              <div aria-live="polite">
                <p className="demo-history__bound">
                  Parámetros enviados: {result.parameters.asset} ·{' '}
                  {result.parameters.from} — {result.parameters.to} ·{' '}
                  {result.parameters.interval} · {result.parameters.strategy} ·
                  Capital inicial: {money(result.parameters.capital)} EUR
                </p>
                <HistoricalMetricCards
                  items={[
                    {
                      label: 'Capital final (EUR)',
                      value: money(result.finalCapital),
                    },
                    {
                      label: 'Drawdown máx.',
                      value: `${money(result.drawdown)} %`,
                    },
                    { label: 'Acierto', value: `${money(result.winRate)} %` },
                    {
                      label: 'Operaciones',
                      value: String(result.trades.length),
                    },
                  ]}
                />
                <HistoricalPanel
                  title="Curva de capital"
                  caption="EJEMPLO · NO ES RENDIMIENTO VALIDADO"
                  variant="curve"
                >
                  <svg
                    viewBox="0 0 800 250"
                    role="img"
                    aria-label="Curva de capital ilustrativa"
                    preserveAspectRatio="none"
                  >
                    <path
                      className="demo-history__area"
                      d={`${equityPath} L 800 250 L 0 250 Z`}
                    />
                    <path className="demo-history__line" d={equityPath} />
                  </svg>
                  <div className="demo-history__axis">
                    <span>{result.parameters.from} UTC</span>
                    <span>{result.parameters.to} UTC</span>
                  </div>
                </HistoricalPanel>
                <HistoricalPanel
                  title="Operaciones del ejemplo"
                  variant="trades"
                >
                  <HistoricalTable>
                    <table>
                      <thead>
                        <tr>
                          <th>Dirección</th>
                          <th>Tamaño (BTC)</th>
                          <th>Entrada (EUR)</th>
                          <th>Salida (EUR)</th>
                          <th>Resultado neto (EUR)</th>
                          <th>Comisiones (EUR)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.map((trade) => (
                          <tr key={trade.id}>
                            <td>
                              {trade.direction === 'long' ? 'Larga' : 'Corta'}
                            </td>
                            <td>{trade.sizeBtc.toFixed(6)}</td>
                            <td>{money(trade.entryEur)}</td>
                            <td>{money(trade.exitEur)}</td>
                            <td>{money(trade.netEur)}</td>
                            <td>{money(trade.feesEur)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </HistoricalTable>
                </HistoricalPanel>
              </div>
            )}
          </>
        }
      />
    </section>
  )
}

function makePath(points: readonly { value: number }[]): string {
  if (points.length === 0) return ''
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const range = Math.max(...values) - min || 1
  return points
    .map(
      (point, index) =>
        ` ${index === 0 ? 'M' : 'L'} ${(index / Math.max(1, points.length - 1)) * 800} ${225 - ((point.value - min) / range) * 200}`,
    )
    .join('')
}
