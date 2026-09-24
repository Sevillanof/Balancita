import { useEffect, useMemo, useState } from 'react'
import type { CandlestickData, SeriesMarker, Time } from 'lightweight-charts'
import PriceChart from '../features/price-chart/presentation/PriceChart.tsx'

type Ohlc = {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}
type FastRun = {
  id: string
  strategyId:
    | 'micro-trend-pullback'
    | 'micro-bollinger-reversion'
    | 'micro-donchian-breakout'
    | 'micro-regime-adapter'
  trades: readonly {
    side: 'buy' | 'sell'
    timestamp: number
    price: number
    pnlEur?: number
  }[]
  netPnlEur: number
  candlesEvaluated: number
  rawSignalsCount: number
  gateRejectionsCount: number
  sampleCount: number
  brierScoreMulticlass: number | null
  winRatePct: number
  profitFactor: number | null
  window: { start_time: number; end_time: number }
}
const STRATEGIES = [
  ['micro-trend-pullback', 'Tendencia: retroceso'],
  ['micro-bollinger-reversion', 'Reversión: Bollinger'],
  ['micro-donchian-breakout', 'Ruptura: Donchian'],
  ['micro-regime-adapter', 'Adaptador de régimen'],
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isFastRun(value: unknown): value is FastRun {
  if (
    !isRecord(value) ||
    !isRecord(value.window) ||
    !Array.isArray(value.trades)
  )
    return false
  return (
    typeof value.id === 'string' &&
    STRATEGIES.some(([id]) => id === value.strategyId) &&
    isFiniteNumber(value.netPnlEur) &&
    isSafeInteger(value.candlesEvaluated) &&
    isSafeInteger(value.rawSignalsCount ?? value.raw_signals_count) &&
    isSafeInteger(value.gateRejectionsCount ?? value.gate_rejections_count) &&
    isSafeInteger(value.sampleCount ?? value.sample_count) &&
    (value.brierScoreMulticlass === null ||
      isFiniteNumber(value.brierScoreMulticlass)) &&
    isFiniteNumber(value.winRatePct) &&
    (value.profitFactor === null || isFiniteNumber(value.profitFactor)) &&
    isSafeInteger(value.window.start_time) &&
    isSafeInteger(value.window.end_time) &&
    (value.window.end_time as number) >= (value.window.start_time as number) &&
    value.trades.every(
      (trade) =>
        isRecord(trade) &&
        (trade.side === 'buy' || trade.side === 'sell') &&
        isSafeInteger(trade.timestamp) &&
        isFiniteNumber(trade.price) &&
        isFiniteNumber(trade.quantity) &&
        isFiniteNumber(trade.feeEur) &&
        (trade.pnlEur === undefined || isFiniteNumber(trade.pnlEur)),
    )
  )
}

function fastRunsFromPayload(payload: unknown): FastRun[] {
  return isRecord(payload) && Array.isArray(payload.runs)
    ? payload.runs.filter(isFastRun)
    : []
}

export default function FastReplaySection() {
  const [strategy, setStrategy] = useState<string>(STRATEGIES[0][0])
  const [candles, setCandles] = useState<readonly Ohlc[]>([])
  const [run, setRun] = useState<FastRun | null>(null)
  const [history, setHistory] = useState<readonly FastRun[]>([])
  const [cursor, setCursor] = useState(-1)
  const [speed, setSpeed] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<{
    candleCount: number
    firstCandleTime: number | null
    lastCandleTime: number | null
  } | null>(null)

  useEffect(() => {
    void fetch('/api/replay/fast-run/history?limit=50')
      .then(async (response) =>
        response.ok ? fastRunsFromPayload(await response.json()) : [],
      )
      .then(setHistory)
      .catch(() => setHistory([]))
  }, [])

  useEffect(() => {
    if (!playing || cursor >= candles.length - 1) return undefined
    const timer = window.setTimeout(() => {
      const next = cursor + 1
      setCursor(next)
      if (next >= candles.length - 1) setPlaying(false)
    }, 1000 / speed)
    return () => window.clearTimeout(timer)
  }, [playing, speed, cursor, candles.length])

  const chartData = useMemo<readonly CandlestickData[]>(
    () =>
      candles.slice(0, cursor + 1).map((candle) => ({
        time: (candle.timestamp / 1000) as Time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [candles, cursor],
  )
  const markers = useMemo<readonly SeriesMarker<Time>[]>(
    () =>
      (run?.trades ?? [])
        .filter(
          ({ timestamp }) =>
            cursor >= 0 && timestamp <= candles[cursor]!.timestamp,
        )
        .map((trade) => ({
          time: (trade.timestamp / 1000) as Time,
          position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
          color: trade.side === 'buy' ? '#13795b' : '#b42318',
          shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
          text: trade.side === 'buy' ? 'Compra' : 'Venta',
        })),
    [run, candles, cursor],
  )

  async function synchronize() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/market/sync-ohlc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hours: 12 }),
      })
      if (!response.ok)
        throw new Error('No se pudieron sincronizar las velas OHLC.')
      const payload: unknown = await response.json()
      if (
        isRecord(payload) &&
        isRecord(payload.coverage) &&
        isSafeInteger(payload.coverage.candle_count) &&
        (payload.coverage.first_candle_time === null ||
          isSafeInteger(payload.coverage.first_candle_time)) &&
        (payload.coverage.last_candle_time === null ||
          isSafeInteger(payload.coverage.last_candle_time))
      )
        setCoverage({
          candleCount: payload.coverage.candle_count,
          firstCandleTime: payload.coverage.first_candle_time,
          lastCandleTime: payload.coverage.last_candle_time,
        })
      await loadHistory()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Ocurrió un error al sincronizar.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function execute() {
    setBusy(true)
    setError(null)
    setPlaying(false)
    try {
      const response = await fetch('/api/replay/fast-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy_id: strategy }),
      })
      const payload: unknown = await response.json()
      if (!response.ok || !isFastRun(payload))
        throw new Error(
          isRecord(payload) &&
            isRecord(payload.error) &&
            typeof payload.error.message === 'string'
            ? payload.error.message
            : 'No se pudo ejecutar el replay.',
        )
      const loaded = await loadCandles(
        payload.window.start_time,
        payload.window.end_time,
      )
      setRun(payload)
      setCandles(loaded)
      setCursor(0)
      setHistory((current) => [payload, ...current].slice(0, 50))
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Ocurrió un error al ejecutar el replay.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function loadHistory() {
    const response = await fetch('/api/replay/fast-run/history?limit=50')
    if (response.ok) {
      setHistory(fastRunsFromPayload(await response.json()))
    }
  }
  async function loadCandles(start: number, end: number) {
    const response = await fetch(
      `/api/market/ohlc?start_time=${start}&end_time=${end}`,
    )
    if (!response.ok)
      throw new Error('No se pudieron cargar las velas guardadas.')
    return ((await response.json()) as { candles: Ohlc[] }).candles
  }
  async function inspect(saved: FastRun) {
    setBusy(true)
    setError(null)
    setPlaying(false)
    try {
      setCandles(
        await loadCandles(saved.window.start_time, saved.window.end_time),
      )
      setRun(saved)
      setCursor(0)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'No se pudo abrir la corrida guardada.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="fast-replay" aria-label="Fast Replay">
      <div className="fast-replay__controls">
        <label>
          Alternativa
          <select
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
          >
            {STRATEGIES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={() => void synchronize()}
        >
          Sincronizar Kraken OHLC (máx. 12h)
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => void execute()}
        >
          {busy ? 'Procesando…' : 'Ejecutar Replay Local'}
        </button>
      </div>
      <p>
        Máximo documentado: 720 velas de 1 minuto (aprox. 12 horas). Kraken no
        permite recuperar OHLC más antiguo, aunque se solicite un `since`
        anterior.
      </p>
      {coverage !== null && (
        <p role="status">
          Cobertura descargada: {coverage.candleCount} velas
          {coverage.firstCandleTime !== null && coverage.lastCandleTime !== null
            ? ` · ${new Date(coverage.firstCandleTime).toLocaleString()} – ${new Date(coverage.lastCandleTime).toLocaleString()}`
            : ''}
        </p>
      )}
      {error !== null && <p role="alert">{error}</p>}
      {run !== null && (
        <div className="fast-replay__results" aria-live="polite">
          <table aria-label="Métricas de Fast Replay">
            <caption>Resultado de la corrida seleccionada · {run.id}</caption>
            <tbody>
              <tr>
                <th scope="row">Velas evaluadas</th>
                <td>{run.candlesEvaluated}</td>
              </tr>
              <tr>
                <th scope="row">Señales brutas</th>
                <td>{run.rawSignalsCount}</td>
              </tr>
              <tr>
                <th scope="row">Rechazos del filtro</th>
                <td>{run.gateRejectionsCount}</td>
              </tr>
              <tr>
                <th scope="row">Ejecuciones</th>
                <td>{run.trades.length}</td>
              </tr>
              <tr>
                <th scope="row">P&amp;L neto después de costos.v1</th>
                <td>{run.netPnlEur.toFixed(2)} €</td>
              </tr>
              <tr>
                <th scope="row">Brier multiclase</th>
                <td>
                  {run.brierScoreMulticlass?.toFixed(4) ?? 'Sin muestras'}
                </td>
              </tr>
              <tr>
                <th scope="row">Baseline uniforme</th>
                <td>0.6667</td>
              </tr>
            </tbody>
          </table>
          <p>
            Factor de beneficio:{' '}
            {run.profitFactor !== null && Number.isFinite(run.profitFactor)
              ? run.profitFactor.toFixed(2)
              : 'No disponible'}
          </p>
        </div>
      )}
      <PriceChart data={chartData} markers={markers} />
      <div
        className="fast-replay__playback"
        role="group"
        aria-label="Controles de reproducción"
      >
        {[1, 5, 20, 50].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={speed === value}
            onClick={() => setSpeed(value)}
          >
            {value}x
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPlaying(true)}
          disabled={candles.length === 0 || cursor >= candles.length - 1}
        >
          Reproducir
        </button>
        <button type="button" onClick={() => setPlaying(false)}>
          Pausar
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false)
            setCursor(-1)
          }}
        >
          Reiniciar
        </button>
      </div>
      <section aria-label="Historial de Fast Replay">
        <h3>Corridas guardadas</h3>
        {history.length === 0 ? (
          <p>Todavía no hay corridas guardadas.</p>
        ) : (
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => void inspect(item)}>
                  {item.id} · {item.strategyId} · {item.netPnlEur.toFixed(2)} €
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
