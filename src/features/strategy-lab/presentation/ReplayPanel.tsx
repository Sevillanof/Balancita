import { useCallback, useEffect, useState } from 'react'
import ApprovedTerminalChart, {
  type ApprovedTerminalMarker,
} from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import { LAB_PRODUCTS, DEFAULT_LAB_PRODUCT } from '../domain/products.ts'
import type { LabCandle } from '../infrastructure/lab-candles.ts'
import {
  httpReplayApi,
  type QwenTrigger,
  type ReplayApi,
  type ReplayDetail,
  type ReplayRun,
} from '../infrastructure/replay-api.ts'
import {
  percent,
  signedPercent,
  signedUsd,
} from '../../../shared/finance/format.ts'

const QWEN_ID = 'qwen'
const POLL_MS = 3000
const DAY_MS = 86_400_000

const TRIGGER_LABELS: Record<QwenTrigger, string> = {
  entry: 'Cuando una estrategia propone entrar',
  '5min': 'Cada 5 minutos',
  all: 'Cada minuto',
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const rangeText = (run: ReplayRun) =>
  `${day(run.start_ms)} → ${day(run.end_ms)}`
const rate = (value: number | null) =>
  value === null ? '—' : percent(value * 100)

function markersFor(
  detail: ReplayDetail,
  focus: string,
  last: number,
): ApprovedTerminalMarker[] {
  if (focus === QWEN_ID) {
    return (detail.qwen?.decisions ?? [])
      .filter((decision) => decision.chosen !== 'hold')
      .map((decision, index) => ({
        id: `qwen-${index}`,
        time: Math.floor(decision.bucket_start / 1000),
        type: 'decision' as const,
        direction: decision.chosen === 'buy' ? 'long' : 'short',
        label: decision.chosen === 'buy' ? 'C' : 'V',
      }))
  }
  return detail.trades
    .filter((trade) => trade.strategy_id === focus)
    .flatMap((trade, index) => [
      {
        id: `entry-${index}`,
        time: Math.floor(trade.entry_time_ms / 1000),
        type: 'entry' as const,
        direction:
          trade.side === 'LONG' ? ('long' as const) : ('short' as const),
        label: trade.side === 'LONG' ? 'L' : 'S',
      },
      {
        id: `exit-${index}`,
        time: Math.min(Math.floor(trade.exit_time_ms / 1000), last),
        type: 'exit' as const,
        label: signedPercent(trade.net_bp / 100, 2),
      },
    ])
}

// One instance for the whole module: a new default per render changes `api`
// on every render, which re-runs the list effect and fetches in a loop.
const DEFAULT_API = httpReplayApi()

export default function ReplayPanel({
  api = DEFAULT_API,
  pollMs = POLL_MS,
}: {
  api?: ReplayApi
  pollMs?: number
}) {
  const [runs, setRuns] = useState<ReplayRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [product, setProduct] = useState(DEFAULT_LAB_PRODUCT)
  const [from, setFrom] = useState(() => day(Date.now() - 3 * DAY_MS))
  const [to, setTo] = useState(() => day(Date.now()))
  const [useQwen, setUseQwen] = useState(false)
  const [trigger, setTrigger] = useState<QwenTrigger>('entry')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ReplayDetail | null>(null)
  const [candles, setCandles] = useState<LabCandle[]>([])
  const [focus, setFocus] = useState<string>('')

  const refresh = useCallback(async () => {
    try {
      setRuns(await api.list())
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [api])

  useEffect(() => {
    let live = true
    api
      .list()
      .then((rows) => live && setRuns(rows))
      .catch((failure: unknown) => {
        if (live)
          setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      live = false
    }
  }, [api])

  const anyRunning = runs?.some((run) => run.status === 'running') ?? false
  useEffect(() => {
    if (!anyRunning) return undefined
    const timer = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(timer)
  }, [anyRunning, pollMs, refresh])

  const selectedRun = runs?.find((run) => run.id === selected)
  const selectedDone = selectedRun?.status === 'done'
  useEffect(() => {
    if (!selected || !selectedDone) return undefined
    let live = true
    void Promise.all([api.detail(selected), api.candles(selected)])
      .then(([loaded, series]) => {
        if (!live) return
        setDetail(loaded)
        setCandles(series)
        setFocus((current) =>
          loaded.summaries.some((row) => row.strategy_id === current) ||
          (current === QWEN_ID && loaded.qwen)
            ? current
            : (loaded.summaries[0]?.strategy_id ?? ''),
        )
      })
      .catch((failure: unknown) => {
        if (live)
          setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      live = false
    }
  }, [api, selected, selectedDone])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const run = await api.start({
        product,
        from,
        to,
        qwen: useQwen ? { trigger } : null,
      })
      setSelected(run.id)
      setDetail(null)
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const last = candles.at(-1)?.time ?? 0
  const markers = detail && focus ? markersFor(detail, focus, last) : []

  return (
    <section
      className="strategy-lab strategy-lab__replays"
      aria-labelledby="replay-title"
    >
      <div className="strategy-lab__panel">
        <div className="strategy-lab__panel-head">
          <h2 id="replay-title">Replay histórico</h2>
          <span className="strategy-lab__context">
            Las estrategias (y Qwen, si lo activás) deciden vela a vela sobre un
            rango, sin ver el futuro · 100 US$ por operación
          </span>
        </div>
        <form
          className="strategy-lab__toolbar"
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          <label>
            Producto{' '}
            <select
              value={product}
              onChange={(event) => setProduct(event.target.value)}
            >
              {LAB_PRODUCTS.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <label>
            Desde{' '}
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            Hasta{' '}
            <input
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={useQwen}
              onChange={(event) => setUseQwen(event.target.checked)}
            />{' '}
            Que Qwen decida a ciegas
          </label>
          {useQwen && (
            <label>
              Preguntarle{' '}
              <select
                value={trigger}
                onChange={(event) =>
                  setTrigger(event.target.value as QwenTrigger)
                }
              >
                {(Object.keys(TRIGGER_LABELS) as QwenTrigger[]).map((id) => (
                  <option key={id} value={id}>
                    {TRIGGER_LABELS[id]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="submit"
            className="strategy-lab__button strategy-lab__button--primary"
            disabled={busy || !from || !to || to <= from}
          >
            Correr replay
          </button>
        </form>
        {error && (
          <p className="strategy-lab__empty" role="alert">
            {error}
          </p>
        )}
        {runs !== null && runs.length === 0 && !error && (
          <p className="strategy-lab__empty">
            Todavía no corriste ningún replay. El rango usa las velas guardadas
            (pnpm --dir server candles:backfill --days 90 trae 90 días).
          </p>
        )}
        {runs !== null && runs.length > 0 && (
          <ul className="strategy-lab__rank-list" aria-label="Replays">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="strategy-lab__chip"
                  aria-pressed={run.id === selected}
                  onClick={() => {
                    setSelected(run.id)
                    setDetail(null)
                  }}
                >
                  {run.product_id} · {rangeText(run)}
                  {run.qwen ? ' · con Qwen' : ''} ·{' '}
                  {run.status === 'running'
                    ? 'corriendo…'
                    : run.status === 'failed'
                      ? 'falló'
                      : 'listo'}
                </button>
                {run.status === 'failed' && run.error && (
                  <span className="strategy-lab__context"> {run.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {detail && (
          <>
            <div className="strategy-lab__table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quién</th>
                    <th>Rentabilidad</th>
                    <th>Acierto</th>
                    <th>Operaciones</th>
                    <th>Decisiones</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.summaries.map((row) => (
                    <tr key={row.strategy_id}>
                      <td>
                        <button
                          type="button"
                          className="strategy-lab__chip"
                          aria-pressed={focus === row.strategy_id}
                          onClick={() => setFocus(row.strategy_id)}
                        >
                          {row.strategy_id}
                        </button>
                      </td>
                      <td
                        className={`strategy-lab__num ${row.pnl_usd >= 0 ? 'is-up' : 'is-down'}`}
                      >
                        {signedPercent(row.return_pct_on_notional, 2)} ·{' '}
                        {signedUsd(row.pnl_usd)}
                      </td>
                      <td className="strategy-lab__num">
                        {rate(row.trade_hit_rate)}
                      </td>
                      <td className="strategy-lab__num">{row.trades}</td>
                      <td className="strategy-lab__num">
                        {rate(row.decision_hit_rate)} de {row.decisions}
                      </td>
                    </tr>
                  ))}
                  {detail.qwen && (
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="strategy-lab__chip strategy-lab__chip--qwen"
                          aria-pressed={focus === QWEN_ID}
                          onClick={() => setFocus(QWEN_ID)}
                        >
                          Qwen
                        </button>
                      </td>
                      <td
                        className={`strategy-lab__num ${detail.qwen.report.trading.return_pct >= 0 ? 'is-up' : 'is-down'}`}
                      >
                        {signedPercent(
                          detail.qwen.report.trading.return_pct,
                          2,
                        )}{' '}
                        · {signedUsd(detail.qwen.report.trading.pnl_usd)}
                      </td>
                      <td className="strategy-lab__num">
                        {rate(detail.qwen.report.trading.hit_rate)}
                      </td>
                      <td className="strategy-lab__num">
                        {detail.qwen.report.trading.trades}
                      </td>
                      <td className="strategy-lab__num">
                        {rate(detail.qwen.report.decisions.hit_rate)} de{' '}
                        {detail.qwen.report.decisions.scored}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="strategy-lab__chart">
              {candles.length > 0 ? (
                <ApprovedTerminalChart
                  candles={candles}
                  markers={markers}
                  selectedId=""
                  intervalSeconds={60}
                  currency="USD"
                  instrument={selectedRun?.product_id ?? 'perpetuo'}
                  onSelect={() => {}}
                  ariaLabel="Velas del rango del replay con las operaciones de lo elegido"
                />
              ) : (
                <p className="strategy-lab__empty">Cargando las velas…</p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
