import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ApprovedTerminalChart from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import { amount } from '../../../shared/finance/format.ts'
import { signedAmount } from '../domain/strategy-format.ts'
import { STAGES, deriveStage } from '../domain/run-stage.ts'
import {
  exitReasonText,
  fundingText,
  holdText,
  madridTime,
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
}: Props) {
  const [overview, setOverview] = useState<GateOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [pickedRun, setPickedRun] = useState<number | null>(null)
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'empty'; reason: 'no-runs' | 'no-trades-saved' }
    | { kind: 'error'; text: string; code: string }
    | { kind: 'ready'; data: Loaded }
  >({ kind: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [moreError, setMoreError] = useState<string | null>(null)
  const token = useRef(0)
  const invalidate = useCallback(() => {
    token.current += 1
  }, [])

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
  }, [gate, strategyId])

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

  // The newest finished run that saved its trades, unless the user picked one.
  useEffect(() => {
    if (overview === null) return
    const mine = ++token.current
    const candidates =
      pickedRun !== null
        ? finished.filter((run) => run.id === pickedRun)
        : finished
    void (async () => {
      if (finished.length === 0) {
        setState({ kind: 'empty', reason: 'no-runs' })
        return
      }
      setState({ kind: 'loading' })
      for (const run of candidates) {
        try {
          await openRun(mine, run.id)
          return
        } catch (error) {
          if (token.current !== mine) return
          const code = error instanceof RunVisualError ? error.code : 'error'
          if (code === 'artifact_not_ready' && pickedRun === null) continue
          setState({ kind: 'error', text: message(error), code })
          return
        }
      }
      if (token.current === mine)
        setState({ kind: 'empty', reason: 'no-trades-saved' })
    })()
    return invalidate
  }, [overview, finished, pickedRun, openRun, invalidate])

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

  const changeProduct = async (product: string) => {
    if (!data) return
    const mine = ++token.current
    setMoreError(null)
    try {
      await loadProduct(mine, data.summary, product)
    } catch (error) {
      if (token.current === mine) setMoreError(message(error))
    }
  }

  const selected =
    data?.trades.find((trade) => trade.trade_id === selectedId) ?? null
  const selectedIndex = selected && data ? data.trades.indexOf(selected) : -1
  const step = (delta: number) => {
    const next = data?.trades[selectedIndex + delta]
    if (next) void select(next)
  }

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

  return (
    <section
      className="runview"
      aria-label={`Última prueba de ${strategyName}`}
      data-testid="run-view"
    >
      <header className="runview__head">
        <div>
          <p className="runview__title">
            {strategyName} <small>v{version}</small>
          </p>
          <p className="runview__sub">
            {lastRun
              ? `Última prueba · ${runName(lastRun)}`
              : 'Sin prueba terminada con operaciones guardadas'}
            {running && ' · hay una prueba en curso'}
          </p>
        </div>
        <p className="runview__stage-label" title={stage.reason}>
          {STAGE_LABEL[stage.index]}
        </p>
      </header>

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
      <p className="runview__hint">{stage.reason}</p>
      {overviewError && (
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
              ? `p${amount(summary.percentile, 0)}`
              : '—'
          }
          note={summary ? `Mínimo: percentil ${summary.min_percentile}` : ''}
          tone={null}
        />
      </div>
      {data && (
        <p className="runview__hint">
          Las cuatro cifras son de la prueba completa (
          {data.summary.products.length}{' '}
          {data.summary.products.length === 1 ? 'producto' : 'productos'}); el
          gráfico muestra un producto a la vez.
          {summary?.verdict === 'INCONCLUSO' && ' El veredicto es inconcluso.'}
        </p>
      )}

      <div className="runview__chart-card">
        <div className="runview__chart-head">
          <h4>
            {data
              ? `${data.product} · Velas de la prueba`
              : 'Velas de la prueba'}
          </h4>
          <div className="runview__controls">
            {finished.length > 1 && (
              <label>
                Prueba{' '}
                <select
                  value={data?.summary.run_id ?? ''}
                  onChange={(event) => setPickedRun(Number(event.target.value))}
                >
                  {finished.map((run) => (
                    <option key={run.id} value={run.id}>
                      {runName(run)} · {run.verdict ?? '—'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {data && data.summary.products.length > 1 && (
              <label>
                Producto{' '}
                <select
                  value={data.product}
                  onChange={(event) => void changeProduct(event.target.value)}
                >
                  {data.summary.products.map((product) => (
                    <option key={product} value={product}>
                      {product} ({data.summary.trades_by_product[product] ?? 0})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        {state.kind === 'loading' && (
          <p className="runview__empty">Cargando la última prueba…</p>
        )}
        {state.kind === 'empty' && (
          <p className="runview__empty" data-testid="run-empty">
            {state.reason === 'no-runs'
              ? 'Todavía no hay pruebas terminadas de esta estrategia. Corré una práctica abajo, en «Prueba fija».'
              : 'Las pruebas anteriores no guardaron sus operaciones, así que no hay gráfico de ellas. Corré una práctica nueva y va a aparecer acá.'}
          </p>
        )}
        {state.kind === 'error' && (
          <p role="alert" className="runview__empty">
            {state.code === 'exam_not_unlocked'
              ? 'El examen todavía no terminó: sus velas y operaciones se muestran recién después.'
              : state.text}
          </p>
        )}
        {moreError && (
          <p role="alert" className="runview__warn">
            {moreError}
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

            {selected && (
              <TradeDetail
                trade={selected}
                index={selectedIndex}
                total={data.trades.length}
                summary={data.summary}
                onStep={step}
              />
            )}
            {data.trades.length > 0 && (
              <TradeTable
                trades={data.trades}
                selectedId={selectedId}
                total={data.total}
                onSelect={(trade) => void select(trade)}
              />
            )}
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

function TradeDetail({
  trade,
  index,
  total,
  summary,
  onStep,
}: {
  trade: RunTrade
  index: number
  total: number
  summary: RunVisualSummary
  onStep: (delta: number) => void
}) {
  const long = trade.side === 'LONG'
  const usd = (value: string | null) =>
    value == null ? 'sin dato' : `${amount(Number(value), 2)} USD`
  return (
    <section className="runview__detail" aria-label="Operación seleccionada">
      <div className="runview__detail-head">
        <h4>
          {long ? 'LONG' : 'SHORT'} · operación {index + 1} de {total}
        </h4>
        <span>
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={index <= 0}
            aria-label="Operación anterior"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => onStep(1)}
            disabled={index >= total - 1}
            aria-label="Operación siguiente"
          >
            ›
          </button>
        </span>
      </div>
      <dl className="runview__facts">
        <div>
          <dt>Entrada</dt>
          <dd>
            {madridTime(trade.entry_time_ms)} · {usd(trade.entry_price)}{' '}
            <small>(precio modelado)</small>
          </dd>
        </div>
        <div>
          <dt>Salida</dt>
          <dd>
            {madridTime(trade.exit_time_ms)} · {usd(trade.exit_price)}{' '}
            <small>(precio modelado)</small>
          </dd>
        </div>
        <div>
          <dt>Motivo de salida</dt>
          <dd>{exitReasonText(trade.exit_reason)}</dd>
        </div>
        <div>
          <dt>Duración</dt>
          <dd>{holdText(trade.exit_time_ms - trade.entry_time_ms)}</dd>
        </div>
        <div>
          <dt>Resultado neto</dt>
          <dd data-tone={trade.net_bp < 0 ? 'bad' : 'good'}>
            {bp(trade.net_bp)}
            {trade.pnl_usd != null &&
              ` · ${signedAmount(trade.pnl_usd, 2)} USD`}
          </dd>
        </div>
        <div>
          <dt>Costes</dt>
          <dd>
            Incluidos en el neto (comisión e impacto modelados) ·{' '}
            {fundingText(trade.funding_status)}
            {trade.funding_usd != null &&
              ` (${signedAmount(trade.funding_usd, 4)} USD)`}
          </dd>
        </div>
        <div>
          <dt>Señal</dt>
          <dd>
            {trade.signal_time_ms != null
              ? madridTime(trade.signal_time_ms)
              : 'La hora de la señal no se guardó.'}
          </dd>
        </div>
      </dl>
      <details className="runview__tech">
        <summary>Ver detalles</summary>
        <p>
          Operación <code>{trade.trade_id}</code> · prueba{' '}
          <code>{summary.run_id}</code> · versión{' '}
          <code>{summary.spec_hash.slice(0, 12)}</code> · costes{' '}
          <code>{summary.cost_model_version}</code>
        </p>
      </details>
    </section>
  )
}

function TradeTable({
  trades,
  selectedId,
  total,
  onSelect,
}: {
  trades: RunTrade[]
  selectedId: string | null
  total: number
  onSelect: (trade: RunTrade) => void
}) {
  return (
    <div className="runview__table-wrap">
      <table className="runview__table">
        <caption>
          Operaciones cerradas de este producto
          {total > trades.length
            ? ` (primeras ${trades.length} de ${total})`
            : ` (${total})`}
        </caption>
        <thead>
          <tr>
            <th scope="col">Lado</th>
            <th scope="col">Entrada</th>
            <th scope="col">Salida</th>
            <th scope="col">Motivo</th>
            <th scope="col" className="runview__num">
              Neto
            </th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <tr
              key={trade.trade_id}
              aria-selected={trade.trade_id === selectedId}
              data-selected={trade.trade_id === selectedId}
            >
              <td>
                <button type="button" onClick={() => onSelect(trade)}>
                  {trade.side}
                </button>
              </td>
              <td>{madridTime(trade.entry_time_ms)}</td>
              <td>{madridTime(trade.exit_time_ms)}</td>
              <td>{exitReasonText(trade.exit_reason)}</td>
              <td className="runview__num">{bp(trade.net_bp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
