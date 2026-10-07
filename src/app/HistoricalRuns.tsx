import { useEffect, useMemo, useRef, useState } from 'react'
import type { CandlestickData, SeriesMarker, Time } from 'lightweight-charts'
import PriceChart from '../features/price-chart/presentation/PriceChart.tsx'
import ReplayRunForm from './ReplayRunForm.tsx'
import HistoricalWorkbench from '../features/trading-view/presentation/HistoricalWorkbench.tsx'
import ApprovedTradingHeader from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'
import { appNavigation } from './app-navigation.ts'
import {
  HistoricalMetricCards,
  HistoricalPanel,
  HistoricalTable,
} from '../features/trading-view/presentation/HistoricalPresentationSlots.tsx'
import {
  isRun,
  nativeTradeTimeMs,
  pythonExecutionTimeMs,
  type Run,
} from './replay-run-contract.ts'
import './DemoShell.css'
import './ConnectedTerminal.css'

type Candle = {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}
type VerifiedArtifact = {
  source: string
  cutoffEpochMs: number
  candles: Candle[]
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function historyFrom(value: unknown): Run[] {
  return record(value) && Array.isArray(value.runs)
    ? value.runs.filter(isRun)
    : []
}
function verifiedArtifact(value: unknown, run: Run): VerifiedArtifact | null {
  if (
    !record(value) ||
    value.schema !== 'fast-replay-artifact.v1' ||
    value.runId !== run.id ||
    typeof run.datasetHash !== 'string' ||
    value.datasetHash !== run.datasetHash ||
    value.source !== 'kraken_rest_ohlc' ||
    value.engineOwner !== 'typescript' ||
    !integer(value.cutoffEpochMs) ||
    value.timestampUnit !== 'unix-seconds' ||
    value.candleIntervalSeconds !== 60 ||
    value.candleTimestampSemantics !== 'bucket-start' ||
    !record(value.window) ||
    value.window.start_time !== run.window.start_time ||
    value.window.end_time !== run.window.end_time ||
    !Array.isArray(value.candles) ||
    value.candles.length === 0
  )
    return null
  const candles = value.candles
  if (
    !candles.every(
      (candle) =>
        record(candle) &&
        integer(candle.timestamp) &&
        [
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        ].every(finite),
    ) ||
    candles.some(
      (candle, index) =>
        index > 0 &&
        (candle as unknown as Candle).timestamp -
          (candles[index - 1] as unknown as Candle).timestamp !==
          60,
    )
  )
    return null
  const rows = candles as unknown as Candle[]
  if (
    rows[0]!.timestamp * 1000 !== run.window.start_time ||
    rows.at(-1)!.timestamp * 1000 !== run.window.end_time
  )
    return null
  return {
    source: value.source,
    cutoffEpochMs: value.cutoffEpochMs,
    candles: rows,
  }
}
const strategyNames: Readonly<Record<string, string>> = {
  'micro-trend-pullback': 'Tendencia: retroceso',
  'micro-bollinger-reversion': 'Reversión: Bollinger',
  'micro-donchian-breakout': 'Ruptura: Donchian',
  'micro-regime-adapter': 'Adaptador de régimen',
}
const eur = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
})

export default function HistoricalRuns() {
  const request = useRef(0)
  const historySelector = useRef<HTMLDetailsElement | null>(null)
  const historyRequest = useRef(0)
  const createdRunRevision = useRef(0)
  const createdRuns = useRef<Run[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [selected, setSelected] = useState<Run | null>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [artifactInfo, setArtifactInfo] = useState<VerifiedArtifact | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null)
  const [historyRetry, setHistoryRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const current = ++historyRequest.current
    const createdRevisionAtRequest = createdRunRevision.current
    void fetch('/api/replay/fast-run/history?limit=50', {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('No se pudo cargar el historial guardado.')
        return historyFrom(await response.json())
      })
      .then((history) => {
        if (current !== historyRequest.current) return
        if (createdRevisionAtRequest === createdRunRevision.current) {
          setRuns(history)
          return
        }
        const historyIds = new Set(history.map(({ id }) => id))
        const newlyCreated = createdRuns.current.filter(
          ({ id }) => !historyIds.has(id),
        )
        setRuns([...newlyCreated, ...history].slice(0, 50))
      })
      .catch((cause: unknown) => {
        if (
          !controller.signal.aborted &&
          current === historyRequest.current &&
          createdRevisionAtRequest === createdRunRevision.current
        )
          setError(
            cause instanceof Error
              ? cause.message
              : 'Error al cargar el historial.',
          )
      })
    return () => controller.abort()
  }, [historyRetry])

  async function select(run: Run) {
    if (historySelector.current) historySelector.current.open = false
    const current = ++request.current
    setSelected(run)
    setCandles([])
    setArtifactInfo(null)
    setArtifactNotice(null)
    setError(null)
    setBusy(true)
    try {
      const response = await fetch(
        `/api/replay/fast-run/history/${encodeURIComponent(run.id)}/artifact`,
      )
      if (!response.ok)
        throw new Error(
          'No se pudo recuperar el artefacto congelado de esta corrida.',
        )
      const payload: unknown = await response.json()
      if (current !== request.current) return
      const artifact = record(payload) ? payload.artifact : undefined
      const frozen = verifiedArtifact(artifact, run)
      setCandles(frozen?.candles ?? [])
      setArtifactInfo(frozen)
      if (frozen === null)
        setArtifactNotice(
          'El artefacto de velas está ausente o no se puede verificar para esta corrida; no se muestran marcadores.',
        )
    } catch (cause) {
      if (current === request.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'No se pudo abrir la corrida guardada.',
        )
    } finally {
      if (current === request.current) setBusy(false)
    }
  }

  function receiveCreatedRun(run: Run, selectionRevision: number) {
    createdRunRevision.current += 1
    createdRuns.current = [
      run,
      ...createdRuns.current.filter(({ id }) => id !== run.id),
    ].slice(0, 50)
    setRuns((existing) =>
      [run, ...existing.filter(({ id }) => id !== run.id)].slice(0, 50),
    )
    if (selectionRevision === request.current) void select(run)
  }

  const chartData = useMemo<readonly CandlestickData<Time>[]>(
    () =>
      candles.map((candle) => ({
        time: candle.timestamp as Time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [candles],
  )
  const markers = useMemo<readonly SeriesMarker<Time>[]>(() => {
    if (selected === null || candles.length === 0) return []
    if (selected.ledgerOwner === 'python-ledger') {
      const ledger = selected.pythonLedger?.ledger
      return (selected.pythonLedger?.executionAudit.fills ?? []).flatMap(
        (audit) => {
          const fill = ledger?.fills[audit.fillIndex]
          const executionAt = pythonExecutionTimeMs(selected, audit.fillIndex)
          if (
            !fill ||
            executionAt === null ||
            fill.side !== audit.fillSide ||
            (fill.side !== 'buy' && fill.side !== 'sell')
          )
            return []
          return [
            {
              time: Math.floor(executionAt / 1000) as Time,
              position: fill.side === 'buy' ? 'belowBar' : 'aboveBar',
              color: fill.side === 'buy' ? '#13795b' : '#b42318',
              shape: fill.side === 'buy' ? 'arrowUp' : 'arrowDown',
              text: fill.side === 'buy' ? 'Compra' : 'Venta',
            },
          ]
        },
      )
    }
    return selected.trades.flatMap((trade) => {
      const timestamp = nativeTradeTimeMs(selected, trade.timestamp)
      return timestamp === null
        ? []
        : [
            {
              time: Math.floor(timestamp / 1000) as Time,
              position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
              color: trade.side === 'buy' ? '#13795b' : '#b42318',
              shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
              text: trade.side === 'buy' ? 'Compra' : 'Venta',
            },
          ]
    })
  }, [selected, candles])

  const owner =
    selected?.ledgerOwner === 'python-ledger'
      ? 'Ledger Python híbrido · señales TypeScript nativas'
      : selected?.strategyOwner === 'typescript-native'
        ? 'TypeScript nativo'
        : selected
          ? 'No disponible'
          : null
  const unavailableFillTimes =
    selected?.ledgerOwner === 'python-ledger'
      ? (selected.pythonLedger?.ledger?.fills.filter(
          (_, index) => pythonExecutionTimeMs(selected, index) === null,
        ).length ?? 0)
      : (selected?.trades.filter(
          (trade) => nativeTradeTimeMs(selected, trade.timestamp) === null,
        ).length ?? 0)

  return (
    <div className="demo-shell connected-terminal">
      <ApprovedTradingHeader
        brandHref="/"
        brandLabel="Balancita, volver a la aplicación"
        navigation={appNavigation('laboratorio')}
        status={<span className="demo-shell__badge">HISTORIAL CONECTADO</span>}
      />
      <main className="demo-shell__main connected-terminal__main">
        <div className="demo-shell__page-heading">
          <p className="demo-shell__eyebrow">BALANCITA · MODO CONECTADO</p>
          <h1>Pruebas históricas</h1>
        </div>
        <HistoricalWorkbench
          form={
            <ReplayRunForm
              getSelectionRevision={() => request.current}
              onRunCreated={receiveCreatedRun}
            />
          }
          results={
            <section
              className="demo-history__panel demo-history__connected-results"
              aria-label="Resultado de corrida guardada"
            >
              <header className="demo-history__connected-heading">
                <div>
                  <p className="demo-shell__eyebrow">RESULTADO CONECTADO</p>
                  <h2>{selected ? `Corrida ${selected.id}` : 'Resultados'}</h2>
                </div>
                <details
                  ref={historySelector}
                  className="demo-history__run-selector"
                >
                  <summary>Historial ({runs.length})</summary>
                  {error && selected === null && (
                    <div role="alert">
                      {error}{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setError(null)
                          setHistoryRetry((value) => value + 1)
                        }}
                      >
                        Reintentar
                      </button>
                    </div>
                  )}
                  {runs.length === 0 && !error && (
                    <p role="status">No hay corridas guardadas.</p>
                  )}
                  <div className="connected-terminal__table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Identidad</th>
                          <th>Estrategia</th>
                          <th>Ventana (UTC)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((run) => (
                          <tr key={run.id}>
                            <td>
                              <button
                                type="button"
                                aria-pressed={selected?.id === run.id}
                                onClick={() => void select(run)}
                              >
                                {run.id}
                              </button>
                            </td>
                            <td>
                              {strategyNames[run.strategyId] ?? run.strategyId}
                            </td>
                            <td>
                              {new Date(run.window.start_time).toISOString()} —{' '}
                              {new Date(run.window.end_time).toISOString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </header>
              {!selected && !busy && (
                <div className="demo-history__panel demo-history__empty">
                  <span aria-hidden="true">◈</span>
                  <h2>Sin resultados todavía</h2>
                  <p>
                    Elegí una corrida guardada para consultar su artefacto
                    congelado y los datos disponibles.
                  </p>
                </div>
              )}
              {busy && (
                <p role="status" aria-busy="true">
                  Cargando artefacto guardado…
                </p>
              )}
              {error && selected && (
                <div role="alert">
                  {error}
                  <button
                    type="button"
                    onClick={() => selected && void select(selected)}
                  >
                    Reintentar
                  </button>
                </div>
              )}
              {selected && (
                <>
                  <HistoricalMetricCards
                    items={[
                      {
                        label: 'Patrimonio final (EUR)',
                        value:
                          selected.finalEquityEur === undefined
                            ? 'No disponible'
                            : eur.format(selected.finalEquityEur),
                      },
                      {
                        label: 'Resultado neto (EUR)',
                        value:
                          selected.netPnlEur === undefined
                            ? 'No disponible'
                            : eur.format(selected.netPnlEur),
                      },
                      { label: 'Drawdown máx.', value: 'No disponible' },
                      {
                        label: 'Ejecuciones',
                        value: String(
                          selected.ledgerOwner === 'python-ledger'
                            ? (selected.pythonLedger?.ledger?.fills.length ?? 0)
                            : selected.trades.length,
                        ),
                      },
                    ]}
                  />
                  <details className="demo-history__run-metadata">
                    <summary>Parámetros, procedencia y auditoría</summary>
                    <div>
                      <p>Propiedad: {owner}</p>
                      {selected.ledgerOwner === 'python-ledger' && (
                        <p>
                          Ledger long/flat con señales TypeScript; no implica
                          estrategia Python nativa ni paridad comparable.
                        </p>
                      )}
                      {selected.ledgerOwner !== 'python-ledger' &&
                        selected.nativeTradeTimestampUnit ===
                          'unix-milliseconds' &&
                        selected.nativeTradeTimestampMeaning ===
                          'simulated-next-15m-candle-open' && (
                          <p>
                            Fills simulados a la apertura de la siguiente vela
                            de 15 minutos; no representan una hora de orden
                            real.
                          </p>
                        )}
                      <p>
                        ID: {selected.id} · Dataset:{' '}
                        {selected.datasetHash ?? 'No disponible'}
                      </p>
                      <p>
                        BTC/EUR ·{' '}
                        {strategyNames[selected.strategyId] ??
                          selected.strategyId}{' '}
                        · ventana fija 15 min ·{' '}
                        {new Date(selected.window.start_time).toISOString()} —{' '}
                        {new Date(selected.window.end_time).toISOString()}
                      </p>
                      <p>
                        Capital inicial:{' '}
                        {selected.initialCashEur === undefined
                          ? 'No disponible'
                          : eur.format(selected.initialCashEur)}{' '}
                        · Modelo: {selected.sizingModel ?? 'No disponible'}
                      </p>
                      <p>
                        Resultado neto:{' '}
                        {selected.netPnlEur === undefined
                          ? 'No disponible'
                          : eur.format(selected.netPnlEur)}{' '}
                        · Patrimonio final:{' '}
                        {selected.finalEquityEur === undefined
                          ? 'No disponible'
                          : eur.format(selected.finalEquityEur)}
                      </p>
                      <p>
                        Comisión/costes:{' '}
                        {selected.feeScenario?.commissionRate === undefined
                          ? 'No disponible'
                          : `${selected.feeScenario.venue ?? 'No disponible'} · comisión ${selected.feeScenario.commissionRate} · deslizamiento ${selected.feeScenario.slippageRate ?? 'No disponible'}`}
                      </p>
                      {selected.feeScenario?.version && (
                        <p>
                          Identidad de costes: {selected.feeScenario.version}
                        </p>
                      )}
                      {selected.feeScenario?.sourceUrl && (
                        <p>
                          Fuente de costes: {selected.feeScenario.sourceUrl} ·
                          verificada{' '}
                          {selected.feeScenario.verifiedAt ?? 'No disponible'}
                        </p>
                      )}
                      {artifactInfo && (
                        <p>
                          Dataset verificado: {artifactInfo.source} · 1 min ·
                          UTC · corte{' '}
                          {new Date(artifactInfo.cutoffEpochMs).toISOString()}
                        </p>
                      )}
                    </div>
                  </details>
                  {artifactNotice && <p role="alert">{artifactNotice}</p>}
                  {unavailableFillTimes > 0 && (
                    <p role="status">
                      {unavailableFillTimes} fills tienen una hora no disponible
                      o no verificable y no se marcan en el gráfico.
                    </p>
                  )}
                  <HistoricalPanel
                    title="Velas del artefacto congelado"
                    caption="NO SE ACTUALIZA CON DATOS ACTUALES"
                    variant="curve"
                  >
                    <PriceChart
                      data={chartData}
                      markers={artifactNotice ? [] : markers}
                      palette="approved-terminal"
                      showVolume
                    />
                  </HistoricalPanel>
                  <HistoricalPanel
                    title="Ejecuciones registradas"
                    variant="trades"
                  >
                    <HistoricalTable>
                      <table>
                        <thead>
                          <tr>
                            <th>Lado</th>
                            <th>
                              {selected.ledgerOwner === 'python-ledger'
                                ? 'Hora (fill modelado, UTC)'
                                : 'Hora (fill simulado · apertura 15m, UTC)'}
                            </th>
                            <th>Precio</th>
                            <th>Cantidad</th>
                            <th>Comisión</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selected.ledgerOwner === 'python-ledger'
                            ? (selected.pythonLedger?.ledger?.fills ?? []).map(
                                (fill, index) => {
                                  const executionAt = pythonExecutionTimeMs(
                                    selected,
                                    index,
                                  )
                                  return (
                                    <tr key={`${selected.id}-${index}`}>
                                      <td>
                                        {fill.side === 'buy'
                                          ? 'Compra'
                                          : fill.side === 'sell'
                                            ? 'Venta'
                                            : 'No disponible'}
                                      </td>
                                      <td>
                                        {executionAt === null
                                          ? 'No disponible'
                                          : new Date(executionAt).toISOString()}
                                      </td>
                                      <td>{eur.format(fill.price)}</td>
                                      <td>{fill.qty}</td>
                                      <td>{eur.format(fill.commission)}</td>
                                    </tr>
                                  )
                                },
                              )
                            : selected.trades.map((trade, index) => (
                                <tr key={`${selected.id}-${index}`}>
                                  <td>
                                    {trade.side === 'buy'
                                      ? 'Compra simulada'
                                      : 'Venta simulada'}
                                  </td>
                                  <td>
                                    {nativeTradeTimeMs(
                                      selected,
                                      trade.timestamp,
                                    ) === null
                                      ? 'No disponible'
                                      : new Date(
                                          nativeTradeTimeMs(
                                            selected,
                                            trade.timestamp,
                                          )!,
                                        ).toISOString()}
                                  </td>
                                  <td>{eur.format(trade.price)}</td>
                                  <td>{trade.quantity}</td>
                                  <td>
                                    {trade.feeEur === undefined
                                      ? 'No disponible'
                                      : eur.format(trade.feeEur)}
                                  </td>
                                </tr>
                              ))}
                        </tbody>
                      </table>
                    </HistoricalTable>
                  </HistoricalPanel>
                </>
              )}
            </section>
          }
        />
      </main>
    </div>
  )
}
