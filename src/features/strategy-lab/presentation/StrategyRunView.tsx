import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ApprovedTerminalChart from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import { amount } from '../../../shared/finance/format.ts'
import { signedAmount } from '../domain/strategy-format.ts'
import { untriedStages, type MarketStage } from '../domain/market-stages.ts'
import { STAGES, deriveStage } from '../domain/run-stage.ts'
import {
  priceLinesOf,
  markerIds,
  tradeOfMarker,
  toChartCandles,
  toMarkers,
  windowAround,
} from '../domain/run-chart-model.ts'
import {
  gateApi,
  type GateApi,
  type GateOverview,
  type GateRun,
} from '../infrastructure/gate-api.ts'
import {
  RunVisualError,
  runVisualApi,
  type RunCandles,
  type RunTrade,
  type RunVisualApi,
  type RunVisualSummary,
} from '../infrastructure/run-visual-api.ts'
import './StrategyRunView.css'

const STAGE_LABEL = [
  'En hipótesis',
  'En optimización',
  'En validación',
  'En examen',
  'Pasó el examen',
]
const DEFAULT_PRODUCT = 'PF_XBTUSD'
const TRADES_PAGE = 500

/** «C27 Ruptura Donchian» → «C27 · Ruptura Donchian». */
const titleOf = (name: string) => name.replace(/^(C\d+)\s+/, '$1 · ')

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const runName = (run: Pick<GateRun, 'id' | 'kind'>) =>
  `${run.kind === 'exam' ? 'Examen' : 'Práctica'} #${run.id}`

const bp = (value: number | null | undefined) => {
  const text = signedAmount(value ?? null, 1)
  return text === null ? '—' : `${text} pb`
}

type Loaded = {
  summary: RunVisualSummary
  product: string
  trades: RunTrade[]
  total: number
  candles: RunCandles | null
  candlesError: string | null
}

type Props = {
  strategyId: string
  strategyName: string
  version: number | string
  gate?: GateApi
  visual?: RunVisualApi
  /** «Modificar» / «Crear»: lead to the laboratory's editor; absent = disabled. */
  onModify?: () => void
  onCreate?: () => void
}

/**
 * Top of the strategy screen: the phase of the strategy, the four figures of
 * its latest finished test and the REAL Kraken candles of that test with the
 * trades it stored. Nothing is drawn that the test did not save.
 */
export default function StrategyRunView({
  strategyId,
  strategyName,
  version,
  gate = gateApi,
  visual = runVisualApi,
  onModify,
  onCreate,
}: Props) {
  const [overview, setOverview] = useState<GateOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'empty'; reason: 'no-runs' | 'no-trades-saved' }
    | { kind: 'error'; text: string; code: string }
    | { kind: 'ready'; data: Loaded }
  >({ kind: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const token = useRef(0)
  const invalidate = useCallback(() => {
    token.current += 1
  }, [])

  const [reload, setReload] = useState(0)
  const [testing, setTesting] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [howMany, setHowMany] = useState(1)
  const [series, setSeries] = useState<{
    done: number
    total: number
    label: string
  } | null>(null)
  const stopSeries = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [testError, setTestError] = useState<string | null>(null)
  const busy = overview?.running != null
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setReload((value) => value + 1), 10_000)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    let alive = true
    gate
      .overview(strategyId)
      .then((data) => {
        if (alive) {
          setOverview(data)
          setOverviewError(null)
        }
      })
      .catch((error) => {
        if (alive) setOverviewError(message(error))
      })
    return () => {
      alive = false
    }
  }, [gate, strategyId, reload])

  const finished = useMemo(
    () =>
      (overview?.runs ?? [])
        .filter((run) => run.status === 'done')
        .sort((a, b) => b.id - a.id),
    [overview],
  )
  const stage = deriveStage(overview)

  /** Trades of one product (newest page first loaded in order) and the candles around the chosen one. */
  const loadProduct = useCallback(
    async (
      mine: number,
      summary: RunVisualSummary,
      product: string,
      keep?: string | null,
    ) => {
      const page = await visual.trades(summary.run_id, product, {
        limit: TRADES_PAGE,
      })
      if (token.current !== mine) return
      const chosen =
        page.trades.find((trade) => trade.trade_id === keep) ??
        page.trades[page.trades.length - 1] ??
        null
      let candles: RunCandles | null = null
      let candlesError: string | null = null
      try {
        candles = await visual.candles(
          summary.run_id,
          product,
          chosen ? windowAround(chosen) : {},
        )
      } catch (error) {
        candlesError = message(error)
      }
      if (token.current !== mine) return
      setSelectedId(chosen?.trade_id ?? null)
      setState({
        kind: 'ready',
        data: {
          summary,
          product,
          trades: page.trades,
          total: page.total,
          candles,
          candlesError,
        },
      })
    },
    [visual],
  )

  const openRun = useCallback(
    async (mine: number, runId: number) => {
      const summary = await visual.summary(runId)
      if (token.current !== mine) return
      const product = summary.products.includes(DEFAULT_PRODUCT)
        ? DEFAULT_PRODUCT
        : (summary.products[0] ?? DEFAULT_PRODUCT)
      await loadProduct(mine, summary, product)
    },
    [visual, loadProduct],
  )

  // The newest finished run that saved its trades. It only reloads when the set of finished runs
  // changes: the 10 s refresh of a running test must not redraw (blink) the chart.
  const loaded = overview !== null
  const finishedIds = useMemo(
    () => finished.map((run) => run.id).join(','),
    [finished],
  )
  useEffect(() => {
    if (!loaded) return
    const mine = ++token.current
    const candidates =
      finishedIds === '' ? [] : finishedIds.split(',').map(Number)
    void (async () => {
      if (candidates.length === 0) {
        setState({ kind: 'empty', reason: 'no-runs' })
        return
      }
      setState({ kind: 'loading' })
      for (const runId of candidates) {
        try {
          await openRun(mine, runId)
          return
        } catch (error) {
          if (token.current !== mine) return
          const code = error instanceof RunVisualError ? error.code : 'error'
          if (code === 'artifact_not_ready') continue
          setState({ kind: 'error', text: message(error), code })
          return
        }
      }
      if (token.current === mine)
        setState({ kind: 'empty', reason: 'no-trades-saved' })
    })()
    return invalidate
  }, [loaded, finishedIds, openRun, invalidate])

  const data = state.kind === 'ready' ? state.data : null

  const select = async (trade: RunTrade) => {
    if (!data) return
    setSelectedId(trade.trade_id)
    const mine = ++token.current
    try {
      const candles = await visual.candles(
        data.summary.run_id,
        data.product,
        windowAround(trade),
      )
      if (token.current !== mine) return
      setState({
        kind: 'ready',
        data: { ...data, candles, candlesError: null },
      })
    } catch (error) {
      if (token.current !== mine) return
      setState({
        kind: 'ready',
        data: { ...data, candles: null, candlesError: message(error) },
      })
    }
  }

  const selected =
    data?.trades.find((trade) => trade.trade_id === selectedId) ?? null

  const candlesData = data?.candles ?? null
  const chartCandles = useMemo(
    () => (candlesData ? toChartCandles(candlesData.candles) : []),
    [candlesData],
  )
  const markers = useMemo(() => {
    if (!data?.candles) return []
    const { from_ms: from, to_ms: to } = data.candles
    return toMarkers(
      data.trades.filter(
        (trade) => trade.entry_time_ms < to && trade.exit_time_ms >= from,
      ),
    )
  }, [data])

  const summary = data?.summary.summary ?? null
  const lastRun = data
    ? finished.find((run) => run.id === data.summary.run_id)
    : null
  const running = overview?.running ?? null
  const untried = untriedStages(overview?.runs ?? [])
  const count = Math.min(Math.max(howMany, 1), Math.max(untried.length, 1))
  const plan = untried.slice(0, count)
  const testNote =
    untried.length > 0
      ? 'Probar la estrategia en etapas distintas del mercado'
      : 'Ya la probaste en todas las etapas del mercado'

  /** Runs the stages one after the other; each waits for the previous test to end. */
  const runSeries = async (stages: MarketStage[]) => {
    stopSeries.current = false
    setPanelOpen(false)
    setTesting(true)
    setTestError(null)
    try {
      for (const [index, stage] of stages.entries()) {
        if (stopSeries.current || !mounted.current) break
        setSeries({ done: index, total: stages.length, label: stage.label })
        const started = await gate.start(strategyId, {
          from: stage.from,
          to: stage.to,
        })
        let latest = await gate.overview(strategyId)
        while (latest.running != null) {
          setOverview(latest)
          await new Promise((resolve) => setTimeout(resolve, 4000))
          if (!mounted.current) return
          latest = await gate.overview(strategyId)
        }
        setOverview(latest)
        const mine = latest.runs.find((run) => run.id === started.run_id)
        if (mine && mine.status !== 'done') {
          setTestError(
            mine.error ??
              `La prueba de ${stage.label} no terminó (${mine.status}). Se frena la serie.`,
          )
          break
        }
      }
    } catch (error) {
      if (mounted.current) setTestError(message(error))
    } finally {
      if (mounted.current) {
        setSeries(null)
        setTesting(false)
        setReload((value) => value + 1)
      }
    }
  }
  // Retired strategies of the old engine are not in the gate's registry.
  const unknownToGate = overviewError?.startsWith('No existe') ?? false

  return (
    <section
      className="runview"
      aria-label={`Última prueba de ${strategyName}`}
      data-testid="run-view"
    >
      <header className="runview__head">
        <div>
          <p className="runview__title">
            {titleOf(strategyName)} <small>v{version}</small>
          </p>
          <p className="runview__sub">
            {lastRun
              ? `Última prueba · ${runName(lastRun)}`
              : 'Sin prueba terminada con operaciones guardadas'}
            {running && ' · hay una prueba en curso'}
          </p>
        </div>
        <div className="runview__side">
          <p className="runview__stage-label" title={stage.reason}>
            {STAGE_LABEL[stage.index]}
          </p>
          <div className="runview__actions" role="group" aria-label="Acciones">
            <button type="button" onClick={onModify} disabled={!onModify}>
              Modificar
            </button>
            <button type="button" onClick={onCreate} disabled={!onCreate}>
              Crear
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen((open) => !open)}
              disabled={testing || running != null || untried.length === 0}
              title={testNote}
              aria-expanded={panelOpen}
            >
              {running || series ? 'Prueba en curso…' : 'Testear'}
            </button>
          </div>
        </div>
      </header>
      {panelOpen && (
        <div
          className="runview__series"
          role="group"
          aria-label="Pruebas seguidas"
        >
          <label>
            ¿Cuántas pruebas seguidas?
            <input
              type="number"
              min={1}
              max={untried.length}
              value={count}
              onChange={(event) => setHowMany(Number(event.target.value) || 1)}
            />
          </label>
          <p className="runview__hint">
            Cada una en una etapa distinta del mercado, una después de otra:{' '}
            {plan.map((stage) => stage.label).join(' → ')}. Quedan{' '}
            {untried.length} etapas sin probar.
          </p>
          <div className="runview__series-actions">
            <button type="button" onClick={() => void runSeries(plan)}>
              Empezar
            </button>
            <button type="button" onClick={() => setPanelOpen(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {testError && (
        <p role="alert" className="runview__warn">
          {testError}
        </p>
      )}

      <ol className="runview__stages" aria-label="Etapa de la estrategia">
        {STAGES.map((name, index) => (
          <li
            key={name}
            className="runview__stage"
            data-reached={index <= stage.index}
            aria-current={index === stage.index ? 'step' : undefined}
          >
            <span className="runview__stage-bar" aria-hidden="true" />
            <span className="runview__stage-name">{name}</span>
          </li>
        ))}
      </ol>
      {series && (
        <div
          className="runview__progress"
          role="progressbar"
          aria-label="Progreso de las pruebas seguidas"
          aria-valuemin={0}
          aria-valuemax={series.total}
          aria-valuenow={series.done}
          aria-valuetext={`Prueba ${series.done + 1} de ${series.total}: ${series.label}`}
        >
          <ol className="runview__progress-steps">
            {Array.from({ length: series.total }, (_, index) => (
              <li
                key={index}
                className="runview__progress-step"
                data-state={
                  index < series.done
                    ? 'done'
                    : index === series.done
                      ? 'current'
                      : 'todo'
                }
              />
            ))}
          </ol>
          <p className="runview__progress-text">
            Prueba {series.done + 1} de {series.total} · {series.label}
            {series.total > 1 && (
              <button
                type="button"
                onClick={() => {
                  stopSeries.current = true
                }}
              >
                Parar después de esta
              </button>
            )}
          </p>
        </div>
      )}
      {overviewError && !unknownToGate && (
        <p role="alert" className="runview__warn">
          No se pudieron leer las pruebas: {overviewError}
        </p>
      )}

      <div className="runview__kpis" data-testid="run-kpis">
        <Kpi
          label="Operaciones cerradas"
          value={summary ? amount(summary.trades, 0) : '—'}
          note={
            summary
              ? `${summary.trades >= summary.min_trades ? '✓' : '✗'} Mínimo: ${summary.min_trades}`
              : ''
          }
          tone={summary && summary.trades < summary.min_trades ? 'bad' : null}
        />
        <Kpi
          label="Neto por operación"
          value={summary ? bp(summary.mean_bp) : '—'}
          note={
            summary
              ? `Después de costes${summary.funding_share != null && summary.funding_share < 0.95 ? ' · funding incompleto' : ''}`
              : ''
          }
          tone={summary && (summary.mean_bp ?? 0) < 0 ? 'bad' : null}
        />
        <Kpi
          label="Períodos positivos"
          value={summary ? `${summary.positive_folds} / ${summary.folds}` : '—'}
          note={
            summary
              ? `Mínimo: ${Math.ceil(summary.min_positive_fold_share * summary.folds - 1e-9)} de ${summary.folds}`
              : ''
          }
          tone={null}
        />
        <Kpi
          label="Frente al azar"
          value={
            summary && summary.percentile != null
              ? `${amount(summary.percentile, 0)} %`
              : '—'
          }
          note={summary ? `Mínimo: percentil ${summary.min_percentile}` : ''}
          tone={null}
        />
      </div>
      <div className="runview__chart-card">
        <div className="runview__chart-head">
          <h4>
            {data
              ? `${data.product} · Velas de la prueba`
              : 'Velas de la prueba'}
          </h4>
          <span className="runview__chart-tags">LONG / SHORT / Salidas</span>
        </div>

        {unknownToGate && (
          <p className="runview__empty" data-testid="run-empty">
            Esta estrategia no tiene pruebas guardadas.
          </p>
        )}
        {state.kind === 'loading' && overviewError === null && (
          <p className="runview__empty">Cargando la última prueba…</p>
        )}
        {state.kind === 'empty' && (
          <p className="runview__empty" data-testid="run-empty">
            {state.reason === 'no-runs'
              ? 'Todavía no hay pruebas terminadas de esta estrategia.'
              : 'Las pruebas anteriores no guardaron sus operaciones: no hay gráfico de ellas.'}
          </p>
        )}
        {state.kind === 'error' && (
          <p role="alert" className="runview__empty">
            {state.code === 'exam_not_unlocked'
              ? 'El examen todavía no terminó: sus velas y operaciones se muestran recién después.'
              : state.text}
          </p>
        )}

        {data && (
          <>
            {data.candlesError ? (
              <p className="runview__empty" data-testid="run-no-candles">
                Sin datos de velas para esta ventana: {data.candlesError}
              </p>
            ) : (
              <div className="runview__chart">
                <ApprovedTerminalChart
                  candles={chartCandles}
                  markers={markers}
                  selectedId={selected ? markerIds(selected).entry : ''}
                  intervalSeconds={60}
                  currency="USD"
                  instrument={data.product}
                  priceLines={priceLinesOf(selected)}
                  showVolume
                  onSelect={(_time, markerId) => {
                    const id = tradeOfMarker(markerId)
                    const trade = data.trades.find((t) => t.trade_id === id)
                    if (trade) void select(trade)
                  }}
                  ariaLabel={`Velas de ${data.product} de la prueba con sus entradas y salidas`}
                />
              </div>
            )}
            {data.candles && data.candles.missing_minutes > 0 && (
              <p className="runview__hint" data-testid="run-gaps">
                Faltan {data.candles.missing_minutes} velas de 1 minuto que
                Kraken no publicó en esta ventana; no se rellenaron.
              </p>
            )}
            {data.total === 0 && (
              <p className="runview__hint" data-testid="run-no-trades">
                La estrategia no abrió posiciones en este producto durante la
                prueba.
              </p>
            )}
            <ul className="runview__legend" aria-label="Leyenda">
              <li>
                <b className="runview__long">L</b> Entrada LONG
              </li>
              <li>
                <b className="runview__short">S</b> Entrada SHORT
              </li>
              <li>
                <b>×</b> Salida
              </li>
              <li className="runview__legend-note">
                {data.summary.label} · eje del gráfico en UTC, tablas en hora de
                Madrid
              </li>
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

function Kpi({
  label,
  value,
  note,
  tone,
}: {
  label: string
  value: string
  note: string
  tone: 'bad' | null
}) {
  return (
    <div className="runview__kpi">
      <span className="runview__kpi-label">{label}</span>
      <strong className="runview__kpi-value" data-tone={tone ?? undefined}>
        {value}
      </strong>
      <span className="runview__kpi-note">{note}</span>
    </div>
  )
}
