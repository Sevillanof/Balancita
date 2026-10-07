import { useEffect, useRef, useState, type ReactNode } from 'react'
import { utcDateTime } from '../shared/finance/format.ts'
import ApprovedTerminalLayout from '../features/trading-view/presentation/ApprovedTerminalLayout.tsx'
import ApprovedTradingHeader from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'
import { appNavigation } from './app-navigation.ts'
import ApprovedMarketRow from '../features/trading-view/presentation/ApprovedMarketRow.tsx'
import ApprovedPortfolioTables from '../features/trading-view/presentation/ApprovedPortfolioTables.tsx'
import type { TerminalTickerStats } from '../features/trading-view/infrastructure/terminal-chart-client.ts'
import {
  parseTerminalEnvelope,
  terminalWebSocketUrl,
  type TerminalBootstrap,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { applyTerminalEvents } from '../features/connected-trading/infrastructure/terminal-state.ts'
import { createTerminalBatcher } from '../features/connected-trading/infrastructure/terminal-batch.ts'
import { projectTerminalQuote } from './terminal-market.ts'
import TerminalDecisions from './TerminalDecisions.tsx'
import type { DecisionRow } from './terminal-decisions.ts'
import SelectedDecision from './SelectedDecision.tsx'
import TerminalMarketChart from './TerminalMarketChart.tsx'
import {
  analysesNotice,
  analysisAction,
  analysisReason,
  entryStateLabel,
  marketStatusLabel,
  money,
  paperEngineLabel,
  quantity,
  reasonLabel,
  shortTime,
  strategyLabel,
  utcTime,
} from './terminal-labels.ts'
import './DemoShell.css'
import './ConnectedTerminal.css'
import { record } from '../shared/wire/decode.ts'

type ViewState = Record<string, unknown>

/** Closed 1 m candles the engine needs before it can decide. */
const WARMUP_CANDLES = 50

export default function FuturesTerminal({
  bootstrap,
  apiBase = '/api',
  sourceSwitch,
}: {
  bootstrap: TerminalBootstrap
  apiBase?: string
  /** Data-source control owned by the entry; rendered inside the header. */
  sourceSwitch?: ReactNode
}) {
  const [state, setState] = useState<ViewState | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commandPending, setCommandPending] = useState(false)
  const [processHealth, setProcessHealth] = useState<Record<string, unknown>>(
    {},
  )
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [commandStatus, setCommandStatus] = useState('')
  const [commandVersion, setCommandVersion] = useState(0)
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(
    null,
  )
  const socketRef = useRef<WebSocket | null>(null)
  const [activeRunId, setActiveRunId] = useState(bootstrap.active_run_id)
  const activeRunRef = useRef(bootstrap.active_run_id)
  const awaitingNewRunRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let socket: WebSocket | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 500
    let lastSeq = 0
    let streamId: string | null = null
    const seen = new Set<string>()
    // One view update per second for price ticks instead of one per event.
    const batcher = createTerminalBatcher((events) =>
      setState((previous) => applyTerminalEvents(previous, events)),
    )
    const openSocket = () => {
      if (cancelled) return
      socket = new WebSocket(terminalWebSocketUrl(apiBase))
      socketRef.current = socket
      socket.onopen = () => {
        setConnected(true)
        retryDelay = 500
        socket?.send(
          JSON.stringify(
            lastSeq > 0 && streamId
              ? {
                  schema_version: 1,
                  type: 'resume',
                  run_id: activeRunRef.current,
                  last_seq: lastSeq,
                }
              : {
                  schema_version: 1,
                  type: 'subscribe',
                  run_id: activeRunRef.current,
                },
          ),
        )
      }
      socket.onmessage = (message) => {
        let raw: unknown
        try {
          raw = JSON.parse(String(message.data)) as unknown
        } catch {
          setError('El flujo devolvió un mensaje ilegible.')
          return
        }
        const event = parseTerminalEnvelope(raw)
        if (!event) {
          setError('El flujo devolvió un evento incompatible.')
          return
        }
        if (event.type === 'snapshot') {
          if (event.run_id !== activeRunRef.current) {
            // Only a requested new run may move the view to another run.
            if (!awaitingNewRunRef.current) return
            awaitingNewRunRef.current = false
            activeRunRef.current = event.run_id
            setActiveRunId(event.run_id)
            setSelectedAnalysisId(null)
          }
          batcher.reset()
          const originalRun = event.run_id === bootstrap.active_run_id
          const watermark = event.data.watermark as number
          streamId = event.stream_id
          lastSeq = watermark
          seen.clear()
          const market = record(event.data.market)
          const snapshotState = record(event.data.state)
          setState({
            ...snapshotState,
            market: {
              ...(originalRun ? record(bootstrap.market) : {}),
              ...record(snapshotState.market),
            },
            terminal_market:
              market.schema_version === 'mock-terminal-market.v1' ||
              market.schema_version === 'futures-terminal-market.v1'
                ? market
                : originalRun &&
                    [
                      'mock-terminal-market.v1',
                      'futures-terminal-market.v1',
                    ].includes(
                      String(record(bootstrap.terminal_market).schema_version),
                    )
                  ? bootstrap.terminal_market
                  : null,
          })
          setCommandVersion(Number(snapshotState.state_version ?? 0))
          setError(null)
          return
        }
        if (event.type === 'resync.required') {
          batcher.reset()
          lastSeq = 0
          streamId = null
          socket?.close()
          return
        }
        if (event.type === 'command.ack')
          setCommandStatus(
            `Comando ${String(event.data.status ?? 'recibido')}; sin fill confirmado.`,
          )
        if (event.type === 'command.result') {
          setCommandPending(false)
          const result = record(record(event.data.result).result)
          if (
            record(event.data.result).status === 'failed' ||
            result.status === 'failed'
          )
            awaitingNewRunRef.current = false
          const outcome = String(result.status ?? 'registrado')
          setCommandStatus(
            outcome === 'failed' || outcome === 'superseded'
              ? `Comando no aplicado: ${outcome}. Vuelve a intentarlo.`
              : `Resultado durable recibido: ${outcome}.`,
          )
        }
        if (event.type === 'protocol.error') {
          awaitingNewRunRef.current = false
          setCommandPending(false)
          setError(
            `Comando rechazado por el servidor: ${String(event.data.code ?? 'error')}`,
          )
          return
        }
        if (event.run_id !== activeRunRef.current || seen.has(event.event_id))
          return
        if (event.type === 'engine.status')
          setState((previous) => ({
            ...(previous ?? {}),
            engine: {
              ...record(previous?.engine),
              ...event.data,
            },
          }))
        if (event.seq <= lastSeq) return
        if (event.seq !== lastSeq + 1) {
          setError('Se detectó un salto en el flujo; resincronizando.')
          batcher.reset()
          lastSeq = 0
          streamId = null
          socket?.close()
          return
        }
        seen.add(event.event_id)
        if (seen.size > 2000) seen.clear()
        lastSeq = event.seq
        if (event.type === 'analysis.completed')
          setCommandVersion((version) => version + 1)
        if (event.type === 'command.result') {
          const appliedVersion = record(
            record(event.data.result).result,
          ).applied_state_version
          if (Number.isSafeInteger(appliedVersion))
            setCommandVersion(Number(appliedVersion))
        }
        batcher.push(event)
      }
      socket.onclose = () => {
        setConnected(false)
        if (cancelled) return
        retryTimer = setTimeout(openSocket, retryDelay)
        retryDelay = Math.min(10_000, retryDelay * 2)
      }
      socket.onerror = () => socket?.close()
    }
    openSocket()
    return () => {
      cancelled = true
      batcher.dispose()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      socket?.close()
      socketRef.current = null
    }
  }, [bootstrap, apiBase])

  const account = record(state?.account)
  const netValue = account.net_usd ?? account.net_complete
  const position = record(state?.position)
  const positions = Array.isArray(state?.positions)
    ? state.positions
    : undefined
  const market = record(state?.terminal_market)
  const marketState = record(state?.market)
  const quote = projectTerminalQuote({
    mode: bootstrap.mode,
    market: record(state?.market ?? bootstrap.market),
    terminalMarket: market,
    position,
  })
  const displayedPrice = quote.price
  const analyses = Array.isArray(state?.analyses) ? state.analyses : []
  const orders = Array.isArray(state?.orders) ? state.orders : []
  const fills = Array.isArray(state?.fills) ? state.fills : []
  const selectedAnalysis =
    analyses
      .map(record)
      .find((analysis) => analysis.analysis_id === selectedAnalysisId) ??
    (analyses.length > 0 ? record(analyses.at(-1)) : null)
  const selectedId = String(selectedAnalysis?.analysis_id ?? '')
  const selectedDecisionTime = selectedAnalysis?.decision_time_ms
  const selectedOrder =
    selectedAnalysis && Number.isSafeInteger(selectedDecisionTime)
      ? orders
          .map(record)
          .find((order) => order.decision_at_ms === selectedDecisionTime)
      : undefined
  const selectedOrderId = selectedOrder?.order_id
  const selectedFills =
    typeof selectedOrderId === 'string'
      ? fills.map(record).filter((fill) => fill.order_id === selectedOrderId)
      : []
  const [displayClock, setDisplayClock] = useState(() => Date.now())
  // The live gateway serves public candles/price while the decision engine is
  // not running: show that state explicitly and render no engine-owned data.
  const engineOff =
    bootstrap.mode === 'paper_live' &&
    (record(state?.engine).status ?? bootstrap.engine?.status) === 'off'
  const localDemo = bootstrap.source === 'local-protection.v1'
  // The live gateway shows paper execution D read-only: it has no command
  // channel yet (PS-06), so controls render disabled.
  const gatewayEngine =
    bootstrap.mode === 'paper_live' &&
    (record(state?.engine).commands ?? bootstrap.engine?.commands) ===
      'unavailable'
  const gatewayEngineStatus =
    record(state?.engine).status ?? bootstrap.engine?.status
  const gatewayEngineReason =
    record(state?.engine).reason ?? bootstrap.engine?.reason
  const showAnalysisTime = localDemo || gatewayEngine
  const change24h = (
    (marketState.ticker_stats ?? record(bootstrap.market).ticker_stats) as {
      change_24h_pct?: unknown
    } | null
  )?.change_24h_pct
  const feedStatus =
    marketState.market_status ?? record(bootstrap.market).status
  const feedTone =
    feedStatus === 'live' ? 'ok' : feedStatus === 'degraded' ? 'warn' : 'bad'
  const feedReason = marketState.reason ?? record(bootstrap.market).reason
  const lastReceivedAt =
    marketState.last_received_at ?? record(bootstrap.market).last_received_at
  const fundingKnown =
    record(bootstrap.market).funding === 'known_current_interval'
  const warmupCandles = Array.isArray(market.candles)
    ? market.candles.length
    : 0
  const decisionRows: DecisionRow[] = analyses
    .slice(-100)
    .reverse()
    .map((item, index) => {
      const analysis = record(item)
      const selector = record(analysis.selector)
      return {
        id: String(analysis.analysis_id ?? index),
        action: analysisAction(analysis),
        strategy: strategyLabel(
          selector.strategy_id ?? analysis.selected_strategy_id,
        ).split(' · ')[0]!,
        reason: analysisReason(analysis, localDemo),
        time: shortTime(analysis.decision_time_ms),
      }
    })
  const originalRunActive = activeRunId === bootstrap.active_run_id
  const localScenarioStatus = localDemo
    ? String(
        record(state?.engine).message ??
          (originalRunActive ? bootstrap.engine?.scenario_status : undefined) ??
          'Escenario iniciado',
      )
    : null
  const entryRisk = record(
    record(state?.engine).risk ??
      (originalRunActive ? bootstrap.engine?.risk : undefined),
  )

  useEffect(() => {
    if (bootstrap.mode !== 'paper_live' || quote.receivedAt === null) return
    const timer = setInterval(() => setDisplayClock(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [bootstrap.mode, quote.receivedAt])

  // Per-process health from the dev supervisor (live gateway only).
  useEffect(() => {
    if (bootstrap.mode !== 'paper_live') return
    let cancelled = false
    const load = () =>
      fetch(`${apiBase}/health`)
        .then((response) => response.json() as Promise<unknown>)
        .then((body) => {
          if (!cancelled) setProcessHealth(record(record(body).processes))
        })
        .catch(() => {})
    void load()
    const timer = setInterval(load, 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [bootstrap.mode, apiBase])
  const downProcesses = Object.entries(processHealth).filter(
    ([, value]) => record(value).status !== 'running',
  )

  const sendCommand = (action: string) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN || !bootstrap || !state)
      return
    setCommandPending(true)
    setCommandStatus('Enviando comando; aceptación no significa fill.')
    if (action === 'paper.new_run') awaitingNewRunRef.current = true
    socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        run_id: activeRunRef.current,
        command_id: crypto.randomUUID(),
        expected_state_version: Number(commandVersion),
        action,
      }),
    )
    setCommandVersion((version) => version + 1)
  }

  const modeLabel = localDemo
    ? 'MOCK · mercado simulado'
    : bootstrap?.mode === 'mock'
      ? 'DATOS Y OPERACIONES SIMULADAS'
      : 'MERCADO REAL · OPERACIONES SIMULADAS'

  return (
    <div className="demo-shell connected-terminal">
      <ApprovedTradingHeader
        brandHref="/"
        brandLabel="Balancita, volver a la aplicación"
        navigation={appNavigation('terminal')}
        status={
          <>
            {sourceSwitch}
            <span className="demo-shell__badge">
              {connected ? 'FLUJO CONECTADO' : 'SIN CONEXIÓN'}
            </span>
            <span>{modeLabel}</span>
            {localScenarioStatus && <span>{localScenarioStatus}</span>}
          </>
        }
      />
      <div className="demo-shell__disclaimer">
        Paper · sin órdenes reales ni conexión privada con Kraken
      </div>
      <main className="demo-shell__main connected-terminal__main">
        <div className="demo-shell__page-heading">
          <p className="demo-shell__eyebrow">BALANCITA · PAPER FUTUROS</p>
          <h1>Terminal</h1>
        </div>
        <ApprovedMarketRow
          identity={
            <div>
              <p className="demo-shell__eyebrow">
                {bootstrap.source === 'local-protection.v1'
                  ? 'MOCK · BTC/USD PERPETUO'
                  : 'KRAKEN FUTURES · BTC/USD PERPETUO'}
              </p>
              <h2>
                Bitcoin <span>/ Dólar</span>
              </h2>
            </div>
          }
          quote={
            <div className="demo-terminal__quote">
              <strong>{money(displayedPrice)}</strong>
              <span>{quote.label}</span>
              {typeof change24h === 'number' && (
                <span data-tone={change24h >= 0 ? 'ok' : 'bad'}>
                  {change24h >= 0 ? '+' : ''}
                  {change24h.toLocaleString('es-ES', {
                    maximumFractionDigits: 2,
                  })}
                  % 24 h
                </span>
              )}
              {bootstrap.mode === 'paper_live' && (
                <small>
                  {quote.eventTime === null
                    ? 'Hora del evento no disponible'
                    : `Evento ${utcDateTime(quote.eventTime)}`}
                  {' · '}
                  {quote.receivedAt === null
                    ? 'Recepción no disponible'
                    : `recibido ${utcDateTime(quote.receivedAt)} · hace ${Math.floor(Math.max(0, displayClock - quote.receivedAt) / 1_000)} s`}
                </small>
              )}
            </div>
          }
          context={
            <div>
              <span>
                {connected
                  ? 'Eventos WebSocket recibidos'
                  : 'Esperando WebSocket'}
              </span>
              {bootstrap.mode === 'paper_live' && (
                <p>
                  {marketStatusLabel(
                    marketState.market_status ??
                      record(bootstrap.market).status,
                  )}
                </p>
              )}
              <p>Run: {activeRunId ?? 'cargando'}</p>
            </div>
          }
        />
        {error && (
          <p role="alert">
            {error} No se sustituyen datos desconectados por mocks.
          </p>
        )}
        {!state && <p role="status">Conectando al runtime de futuros…</p>}
        {state && (
          <>
            {bootstrap.mode === 'paper_live' && (
              <section
                className="connected-terminal__panel"
                aria-label="Estado del sistema"
              >
                <ul className="connected-terminal__chips">
                  <li data-tone={feedTone}>
                    Feed: {marketStatusLabel(feedStatus)}
                  </li>
                  <li data-tone={fundingKnown ? 'ok' : 'warn'}>
                    Funding: {fundingKnown ? 'conocido' : 'desconocido'}
                  </li>
                  {gatewayEngine && !engineOff && (
                    <li>
                      Motor paper:{' '}
                      {paperEngineLabel(
                        gatewayEngineStatus,
                        gatewayEngineReason,
                      )}
                    </li>
                  )}
                  {downProcesses.map(([name, value]) => (
                    <li key={name} data-tone="bad">
                      Proceso {name}:{' '}
                      {record(value).status === 'restarting'
                        ? 'reiniciando'
                        : 'caído'}
                    </li>
                  ))}
                  {!engineOff && warmupCandles < WARMUP_CANDLES && (
                    <li data-tone="warn">
                      Calentando {warmupCandles}/{WARMUP_CANDLES}
                    </li>
                  )}
                </ul>
                <details>
                  <summary>Detalle del feed</summary>
                  <p>
                    Última recepción:{' '}
                    {Number.isSafeInteger(lastReceivedAt)
                      ? utcDateTime(Number(lastReceivedAt))
                      : 'Aún no hay datos recibidos'}
                  </p>
                  {typeof feedReason === 'string' && (
                    <p>Motivo del estado: {feedReason}</p>
                  )}
                  <p>
                    Integridad del libro:{' '}
                    {String(
                      record(
                        marketState.book_quality ??
                          record(bootstrap.market).book_quality,
                      ).book_sequence_integrity ??
                        record(bootstrap.market).book_quality ??
                        'No verificada',
                    )}
                  </p>
                  <p>Garantía de secuencia del proveedor: no documentada.</p>
                  <p>
                    Profundidad bid/ask: no expuesta por el DTO de terminal.
                  </p>
                  <p>
                    Financiación:{' '}
                    {fundingKnown
                      ? 'cobertura del período actual disponible; tasa y límites del período no se exponen en esta API.'
                      : 'desconocida; entradas bloqueadas y PnL neto incompleto.'}
                  </p>
                </details>
              </section>
            )}
            <ApprovedTerminalLayout
              chart={
                <section
                  className="demo-terminal__panel"
                  aria-label="Gráfico BTC/USD"
                >
                  <h2>BTC/USD perpetuo</h2>
                  <TerminalMarketChart
                    market={market}
                    mode={bootstrap.mode}
                    analyses={localDemo || gatewayEngine ? analyses : []}
                    selectedId={localDemo || gatewayEngine ? selectedId : ''}
                    entriesOnly={!localDemo}
                    onSelect={setSelectedAnalysisId}
                    apiBase={apiBase}
                    ticker={
                      (marketState.ticker_stats ??
                        record(bootstrap.market).ticker_stats ??
                        null) as TerminalTickerStats | null
                    }
                    position={position}
                    positions={positions}
                    orders={orders}
                  />
                  {!engineOff && (
                    <p>
                      Las cifras de cuenta y decisiones siguientes provienen del
                      snapshot/eventos durables.
                    </p>
                  )}
                </section>
              }
              decisions={
                <TerminalDecisions
                  rows={decisionRows}
                  selectedId={selectedId}
                  onSelect={setSelectedAnalysisId}
                  notice={
                    engineOff
                      ? 'Motor de decisiones apagado. Solo se muestran velas y precio públicos de Kraken Futures; no hay análisis, cuenta ni operaciones simuladas.'
                      : !analyses.length && gatewayEngine
                        ? analysesNotice(
                            gatewayEngineStatus,
                            gatewayEngineReason,
                          )
                        : null
                  }
                  selected={
                    selectedAnalysis && !engineOff ? (
                      <SelectedDecision
                        analysis={selectedAnalysis}
                        id={selectedId}
                        time={utcTime(selectedDecisionTime)}
                        reason={analysisReason(selectedAnalysis, localDemo)}
                      />
                    ) : null
                  }
                >
                  {localDemo && selectedAnalysis && (
                    <section aria-label="Análisis seleccionado">
                      <h3>Análisis seleccionado</h3>
                      <dl>
                        <dt>ID de análisis</dt>
                        <dd>{selectedId || 'ID no disponible'}</dd>
                        <dt>Hora</dt>
                        <dd>{utcTime(selectedDecisionTime)}</dd>
                        <dt>Motivo</dt>
                        <dd>{analysisReason(selectedAnalysis, true)}</dd>
                      </dl>
                      {selectedOrder ? (
                        <div>
                          <h4>Efecto durable</h4>
                          <dl>
                            <dt>ID de orden</dt>
                            <dd>{String(selectedOrder.order_id)}</dd>
                            <dt>Tipo / dirección</dt>
                            <dd>
                              {String(
                                selectedOrder.order_type ??
                                  selectedOrder.type ??
                                  'Tipo no disponible',
                              )}{' '}
                              ·{' '}
                              {String(
                                selectedOrder.side ?? 'Dirección no disponible',
                              )}
                            </dd>
                            <dt>Estado</dt>
                            <dd>
                              {String(
                                selectedOrder.state ??
                                  selectedOrder.status ??
                                  'Estado no disponible',
                              )}
                            </dd>
                            <dt>Cantidad</dt>
                            <dd>
                              {quantity(
                                selectedOrder.quantity_btc ??
                                  selectedOrder.quantity,
                              )}
                            </dd>
                            <dt>Motivo de la orden</dt>
                            <dd>
                              {String(
                                selectedOrder.reason_code ??
                                  selectedOrder.reason ??
                                  'No disponible',
                              )}
                            </dd>
                          </dl>
                          <h4>Ejecuciones de la orden</h4>
                          {selectedFills.length > 0 ? (
                            <ul>
                              {selectedFills.map((fill, index) => (
                                <li key={String(fill.fill_id ?? index)}>
                                  {String(fill.fill_id ?? 'Ejecución')} ·{' '}
                                  {quantity(fill.quantity_btc)} @{' '}
                                  {money(fill.price_usd_per_btc)} ·{' '}
                                  {utcTime(fill.event_time_ms)}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>Sin ejecuciones registradas para esta orden.</p>
                          )}
                        </div>
                      ) : (
                        <p>Sin efecto</p>
                      )}
                    </section>
                  )}
                </TerminalDecisions>
              }
            />
            {!engineOff && (
              <>
                <section
                  className="connected-terminal__panel"
                  aria-label="Controles paper"
                >
                  <h2>Controles simulados</h2>
                  {localDemo && (
                    <>
                      <p>
                        Pausar entradas bloquea solo nuevas entradas en esta
                        ejecución MOCK; no detiene el motor, el mercado
                        simulado, la protección ni los cierres.
                      </p>
                      <p>{entryStateLabel(entryRisk)}</p>
                    </>
                  )}
                  {gatewayEngine && (
                    <p>
                      Pausar, reanudar y cerrar llegarán en PS-06: por ahora el
                      terminal live es de solo lectura.
                    </p>
                  )}
                  {(localDemo
                    ? ([
                        'paper.pause',
                        'paper.resume',
                        'paper.new_run',
                      ] as const)
                    : gatewayEngine
                      ? ([
                          'paper.pause',
                          'paper.resume',
                          'paper.close',
                        ] as const)
                      : ([
                          'paper.start',
                          'paper.pause',
                          'paper.resume',
                          'paper.close',
                          'paper.new_run',
                        ] as const)
                  )
                    .filter((action) => action !== 'paper.new_run')
                    .map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="demo-terminal__present"
                        disabled={gatewayEngine || !connected || commandPending}
                        onClick={() => {
                          if (action === 'paper.new_run') {
                            setConfirmingReset(true)
                            return
                          }
                          sendCommand(action)
                        }}
                      >
                        {
                          (localDemo
                            ? {
                                'paper.start': 'Iniciar simulación',
                                'paper.pause': 'Pausar entradas (MOCK)',
                                'paper.resume': 'Reanudar entradas (MOCK)',
                                'paper.close': 'Cerrar posición',
                                'paper.new_run': 'Nueva cuenta/run (MOCK)',
                              }
                            : {
                                'paper.start': 'Iniciar simulación',
                                'paper.pause': 'Pausar entradas',
                                'paper.resume': 'Reanudar entradas',
                                'paper.close': 'Cerrar posición',
                                'paper.new_run': 'Nueva cuenta/run',
                              })[action]
                        }
                      </button>
                    ))}
                  <div
                    className="connected-terminal__reset"
                    role="group"
                    aria-label="Reiniciar cuenta"
                  >
                    {confirmingReset ? (
                      <>
                        <p role="alert">
                          {localDemo
                            ? 'Se crea una cuenta/run MOCK nueva que repite el escenario; el historial anterior se conserva.'
                            : 'Se crea una cuenta/run nuevo; el historial anterior se conserva.'}
                        </p>
                        <button
                          type="button"
                          className="demo-terminal__present"
                          disabled={!connected || commandPending}
                          onClick={() => {
                            setConfirmingReset(false)
                            sendCommand('paper.new_run')
                          }}
                        >
                          Confirmar nueva cuenta
                        </button>
                        <button
                          type="button"
                          className="demo-terminal__present"
                          onClick={() => setConfirmingReset(false)}
                        >
                          Cancelar
                        </button>
                      </>
                    ) : (
                      !gatewayEngine && (
                        <button
                          type="button"
                          className="demo-terminal__present"
                          disabled={!connected || commandPending}
                          onClick={() => setConfirmingReset(true)}
                        >
                          {localDemo
                            ? 'Nueva cuenta/run (MOCK)'
                            : 'Nueva cuenta/run'}
                        </button>
                      )
                    )}
                  </div>
                  {commandPending && (
                    <span role="status">
                      Comando enviado; aceptación no significa fill.
                    </span>
                  )}
                  {commandStatus && <p role="status">{commandStatus}</p>}
                </section>
                <section
                  className="connected-terminal__panel"
                  aria-label="Cuenta paper"
                >
                  <h2>Cuenta paper</h2>
                  <div>
                    <dl>
                      <dt>Saldo USD</dt>
                      <dd>{money(account.cash_usd)}</dd>
                      <dt>Patrimonio USD</dt>
                      <dd
                        title={String(account.equity_usd ?? '')}
                        data-value={String(account.equity_usd ?? '')}
                      >
                        {money(account.equity_usd, localDemo ? 5 : 2)}
                      </dd>
                      {showAnalysisTime && (
                        <>
                          <dt>PnL bruto realizado USD</dt>
                          <dd
                            title={String(account.realized_gross_usd ?? '')}
                            data-value={String(
                              account.realized_gross_usd ?? '',
                            )}
                          >
                            {money(account.realized_gross_usd, 5)}
                          </dd>
                        </>
                      )}
                      <dt>Fees USD</dt>
                      <dd
                        title={String(account.fees_usd ?? '')}
                        data-value={String(account.fees_usd ?? '')}
                      >
                        {money(account.fees_usd, localDemo ? 5 : 2)}
                      </dd>
                      <dt>Funding pagado (USD)</dt>
                      <dd>
                        {account.funding_complete === true
                          ? money(
                              account.funding_paid_usd ?? account.funding_paid,
                            )
                          : 'Incompleto · neto no disponible'}
                      </dd>
                      <dt>PnL neto</dt>
                      <dd
                        {...(localDemo && netValue != null
                          ? {
                              title: String(netValue),
                              'data-value': String(netValue),
                            }
                          : {})}
                      >
                        {netValue == null
                          ? account.funding_complete === true
                            ? 'No disponible durante posición abierta'
                            : 'Incompleto'
                          : money(netValue, localDemo ? 5 : 2)}
                      </dd>
                      <dt>Posición</dt>
                      <dd>
                        {position.side
                          ? `${String(position.side)} · ${quantity(position.quantity_btc)}`
                          : localDemo
                            ? `${quantity(position.quantity_btc ?? '0')} · Sin exposición`
                            : 'Sin posición abierta'}
                      </dd>
                    </dl>
                  </div>
                </section>
                <ApprovedPortfolioTables
                  label="CARTERA PAPER · USD / BTC"
                  title="Posiciones y operaciones"
                  ariaLabel="Posiciones paper"
                  open={{
                    title: 'Posición abierta',
                    columns: [
                      'Estrategia',
                      'Dirección',
                      'Cantidad BTC',
                      'Entrada USD',
                      'Stop USD',
                      'Objetivo USD',
                    ],
                    emptyLabel: 'Sin posición abierta.',
                    rows: position.side
                      ? [
                          {
                            id: String(state.run_id),
                            cells: [
                              strategyLabel(position.strategy_id).split(
                                ' · ',
                              )[0]!,
                              String(position.side),
                              quantity(position.quantity_btc),
                              money(position.entry_price_usd_per_btc),
                              money(position.stop),
                              money(position.target),
                            ],
                          },
                        ]
                      : [],
                  }}
                  closed={{
                    title: 'Órdenes y ejecuciones',
                    columns: ['Tipo', 'Estado', 'Referencia'],
                    emptyLabel: 'No hay órdenes registradas.',
                    rows: [
                      ...orders.slice(-100).map((value, index) => {
                        const order = record(value)
                        return {
                          id: String(order.order_id ?? index),
                          cells: [
                            String(
                              order.side ??
                                order.action ??
                                order.order_type ??
                                'Orden paper',
                            ),
                            reasonLabel(order.status ?? order.type),
                            `${String(order.quantity_btc ?? 'Cantidad no disponible')} · ${String(order.order_id ?? 'ID no disponible')}${
                              gatewayEngine &&
                              typeof order.reason_code === 'string'
                                ? ` · ${reasonLabel(order.reason_code)}`
                                : ''
                            }`,
                          ],
                        }
                      }),
                      ...(Array.isArray(state.fills) ? state.fills : [])
                        .slice(-100)
                        .map((value, index) => {
                          const fill = record(value)
                          return {
                            id: String(fill.fill_id ?? `fill-${index}`),
                            cells: [
                              `Ejecución ${String(fill.action ?? fill.side ?? 'paper')}`,
                              `${quantity(fill.quantity_btc)} @ ${money(fill.price_usd_per_btc)}`,
                              String(fill.fill_id ?? 'Fill registrado'),
                            ],
                          }
                        }),
                    ],
                  }}
                />
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
