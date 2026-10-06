import { useEffect, useRef, useState, type ReactNode } from 'react'
import ApprovedTerminalLayout from '../features/trading-view/presentation/ApprovedTerminalLayout.tsx'
import ApprovedTradingHeader from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'
import ApprovedMarketRow from '../features/trading-view/presentation/ApprovedMarketRow.tsx'
import ApprovedPortfolioTables from '../features/trading-view/presentation/ApprovedPortfolioTables.tsx'
import ApprovedTerminalChart, {
  type ApprovedTerminalCandle,
  type ApprovedTerminalMarker,
} from '../features/trading-view/presentation/ApprovedTerminalChart.tsx'
import {
  parseTerminalEnvelope,
  terminalWebSocketUrl,
  type TerminalBootstrap,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { applyTerminalEvent } from '../features/connected-trading/infrastructure/terminal-state.ts'
import { projectTerminalQuote } from './terminal-market.ts'
import { reasonLabel as baseReasonLabel } from './terminal-copy.ts'
import './DemoShell.css'
import './ConnectedTerminal.css'

type ViewState = Record<string, unknown>

function reasonLabel(value: unknown): string {
  if (value === 'entries_paused')
    return 'Entradas pausadas: el motor no abre nuevas posiciones'
  return baseReasonLabel(value)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function money(value: unknown, maximumFractionDigits = 2): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
    return 'No disponible'
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(Number(value))
}

function quantity(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))
    return 'No disponible'
  return `${value} BTC`
}

function utcTime(value: unknown): string {
  if (!Number.isSafeInteger(value)) return 'Hora no disponible'
  return `${new Date(Number(value)).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`
}

function analysisAction(value: unknown): string {
  const analysis = record(value)
  return String(
    analysis.action ?? record(analysis.selector).action ?? 'WAIT',
  ).toUpperCase()
}

function analysisReason(value: unknown, preferOwnReason = false): string {
  const analysis = record(value)
  const selector = record(analysis.selector)
  const proposals = Array.isArray(analysis.proposals) ? analysis.proposals : []
  const selectedProposal = proposals.find(
    (proposal) =>
      record(proposal).strategy_id ===
      (selector.strategy_id ?? analysis.selected_strategy_id),
  )
  const reasonCodes = Array.isArray(analysis.reason_codes)
    ? analysis.reason_codes
    : []
  const analysisReasonCode = analysis.reason_code
  const firstReasonCode = reasonCodes[0]
  const selectorReason =
    selector.reason_code ?? record(selectedProposal).reason_code
  const reason = preferOwnReason
    ? (analysisReasonCode ?? firstReasonCode ?? selectorReason)
    : (selectorReason ?? firstReasonCode ?? analysisReasonCode)
  if (preferOwnReason && reason === 'position_closed_this_cycle')
    return 'La posición se cerró durante este ciclo'
  return reasonLabel(reason)
}

function strategyLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    return 'Sin estrategia seleccionada'
  const known: Record<string, string> = {
    'c25-pullback-perp-v1': 'C25 · retroceso (experimental)',
    'c26-reversion-perp-v1': 'C26 · reversión (experimental)',
    'c27-breakout-perp-v1': 'C27 · ruptura (experimental)',
    'c28-adapter-perp-v1': 'C28 · adaptador (experimental)',
  }
  return known[value] ?? 'Sin estrategia seleccionada'
}

function entryStateLabel(risk: Record<string, unknown>): string {
  if (Object.keys(risk).length === 0) return 'Estado de entradas no disponible'
  if (risk.daily_loss_latched === true)
    return 'Entradas bloqueadas por límite de pérdida diaria'
  if (risk.user_paused === true)
    return 'Entradas pausadas por el usuario (MOCK)'
  if (risk.entry_paused === true || risk.system_paused === true)
    return 'Entradas pausadas por el sistema'
  return 'Entradas activas'
}

function paperEngineLabel(status: unknown, reason: unknown): string {
  const labels: Record<string, string> = {
    running: 'en marcha',
    idle: 'inactivo',
    starting: 'arrancando',
    unavailable: 'no disponible',
  }
  const reasons: Record<string, string> = {
    paper_execution_active: 'ejecución paper activa',
    no_recent_paper_execution_activity: 'sin actividad reciente',
    account_db_not_ready: 'la cuenta paper aún no existe',
    no_paper_execution_records_yet: 'aún sin registros de ejecución',
    account_db_unreadable: 'no se puede leer la cuenta paper',
  }
  const label = labels[String(status)] ?? 'estado desconocido'
  const detail = typeof reason === 'string' ? reasons[reason] : undefined
  return detail ? `${label} (${detail})` : label
}

function marketStatusLabel(value: unknown): string {
  const labels: Record<string, string> = {
    connecting: 'Conectando',
    syncing: 'Sincronizando libro',
    live: 'Feed activo',
    degraded: 'Feed degradado',
    stale: 'Feed desactualizado',
    disconnected: 'Feed desconectado',
    stopped: 'Feed detenido',
    unavailable: 'Feed no disponible',
  }
  return typeof value === 'string'
    ? (labels[value] ?? 'Estado del feed no disponible')
    : 'Estado del feed no disponible'
}

function TerminalMarketChart({
  market,
  mode,
  analyses,
  selectedId,
  entriesOnly = false,
  onSelect,
}: {
  market: Record<string, unknown>
  mode: TerminalBootstrap['mode']
  analyses: unknown[]
  selectedId: string
  /** Mark only LONG/SHORT verdicts: a WAIT every minute would bury the chart. */
  entriesOnly?: boolean
  onSelect: (analysisId: string) => void
}) {
  const candles: ApprovedTerminalCandle[] = Array.isArray(market.candles)
    ? market.candles.flatMap((value) => {
        const candle = record(value)
        const values = ['open', 'high', 'low', 'close', 'volume_btc'].map(
          (key) => Number(candle[key]),
        )
        if (
          !Number.isSafeInteger(candle.time_ms) ||
          values.some((number) => !Number.isFinite(number))
        )
          return []
        return [
          {
            time: Math.floor(Number(candle.time_ms) / 1000),
            open: values[0]!,
            high: values[1]!,
            low: values[2]!,
            close: values[3]!,
            volume: values[4]!,
          },
        ]
      })
    : []
  if (
    !['mock-terminal-market.v1', 'futures-terminal-market.v1'].includes(
      String(market.schema_version),
    ) ||
    candles.length === 0
  )
    return <p>El snapshot no contiene velas BTC/USD verificables.</p>
  const markers: ApprovedTerminalMarker[] = analyses.flatMap((value) => {
    const analysis = record(value)
    const id = analysis.analysis_id
    const time = analysis.decision_time_ms
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      !Number.isSafeInteger(time)
    )
      return []
    const action = analysisAction(analysis)
    if (entriesOnly && action !== 'LONG' && action !== 'SHORT') return []
    // Verdicts rebuilt from a backfill were not decisions taken at that time
    // (paper execution ignores them too: max_verdict_lag_ms).
    if (entriesOnly && Number(analysis.knowledge_lag_ms) > 15_000) return []
    // A verdict older than the chart has no candle: do not pile it on the first.
    if (entriesOnly && Number(time) < candles[0]!.time * 1000) return []
    const decisionSeconds = Math.floor(Number(time) / 1000)
    const renderTime = candles.reduce(
      (latestTime, candle) =>
        candle.time <= decisionSeconds ? candle.time : latestTime,
      candles[0]!.time,
    )
    const direction =
      action === 'LONG' ? 'long' : action === 'SHORT' ? 'short' : undefined
    return [
      {
        id,
        time: renderTime,
        type: direction ? 'entry' : 'discard',
        ...(direction ? { direction } : {}),
        label: direction ? action : 'WAIT',
      },
    ]
  })
  const intervalSeconds = Number(market.interval_ms) / 1000
  return (
    <>
      <p>
        {mode === 'paper_live'
          ? 'Velas públicas de Kraken Futures · operaciones simuladas.'
          : mode === 'replay'
            ? 'Velas cerradas del origen registrado · operaciones simuladas.'
            : 'Velas cerradas del fixture determinista MOCK · actualización por WebSocket.'}
      </p>
      {market.candles instanceof Array && market.candles.length > 0 && (
        <p role="status">
          {record(market.candles.at(-1)).closed === true
            ? 'Última vela cerrada'
            : 'Vela en formación'}
        </p>
      )}
      <ApprovedTerminalChart
        candles={candles}
        markers={markers}
        selectedId={selectedId}
        intervalSeconds={intervalSeconds}
        currency="USD"
        instrument="BTC/USD perpetuo"
        initialViewport="approved-terminal"
        onSelect={(time, markerId) => {
          if (markerId) {
            onSelect(markerId)
            return
          }
          if (!Number.isFinite(time) || !(intervalSeconds > 0)) return
          const bucket = Math.floor(time / intervalSeconds) * intervalSeconds
          const bucketMarkers = markers.filter(
            (marker) =>
              Math.floor(marker.time / intervalSeconds) * intervalSeconds ===
              bucket,
          )
          if (bucketMarkers.length === 0) return
          const current = bucketMarkers.findIndex(
            (marker) => marker.id === selectedId,
          )
          const next = bucketMarkers[(current + 1) % bucketMarkers.length]
          if (next) onSelect(next.id)
        }}
      />
    </>
  )
}

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
        setState((previous) => applyTerminalEvent(previous, event))
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
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      socket?.close()
      socketRef.current = null
    }
  }, [bootstrap, apiBase])

  const account = record(state?.account)
  const netValue = account.net_usd ?? account.net_complete
  const position = record(state?.position)
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
      : bootstrap?.mode === 'paper_live'
        ? 'MERCADO REAL · OPERACIONES SIMULADAS'
        : 'REPLAY · OPERACIONES SIMULADAS'

  return (
    <div className="demo-shell connected-terminal">
      <ApprovedTradingHeader
        brandHref="/"
        brandLabel="Balancita, volver a la aplicación"
        navigation={[
          { href: '/terminal', label: 'Terminal', current: true },
          { href: '/historicos', label: 'Pruebas históricas' },
        ]}
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
        {modeLabel}. Ninguna orden real ni conexión privada con Kraken.
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
              {bootstrap.mode === 'paper_live' && (
                <small>
                  {quote.eventTime === null
                    ? 'Hora del evento no disponible'
                    : `Evento ${new Date(quote.eventTime).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`}
                  {' · '}
                  {quote.receivedAt === null
                    ? 'Recepción no disponible'
                    : `recibido ${new Date(quote.receivedAt).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC · hace ${Math.floor(Math.max(0, displayClock - quote.receivedAt) / 1_000)} s`}
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
            {bootstrap?.mode === 'replay' && (
              <section aria-label="Evidencia del replay">
                <p>Origen registrado · operaciones simuladas</p>
                <dl>
                  <dt>Hash del dataset</dt>
                  <dd className="connected-terminal__hash">
                    {String(
                      bootstrap.source_manifest?.source_hash ?? 'No disponible',
                    )}
                  </dd>
                  <dt>Hash del archivo fuente</dt>
                  <dd className="connected-terminal__hash">
                    {String(
                      bootstrap.source_manifest?.source_file_hash ??
                        'No disponible',
                    )}
                  </dd>
                </dl>
                <a
                  href={`${apiBase}/terminal/export`}
                  download="futures-replay-export.json"
                >
                  Descargar exportación verificada del run
                </a>
              </section>
            )}
            {bootstrap.mode === 'paper_live' && (
              <section
                className="connected-terminal__panel"
                aria-label="Calidad del mercado público"
              >
                <h2>Calidad del feed público</h2>
                <p>
                  Estado:{' '}
                  {marketStatusLabel(
                    marketState.market_status ??
                      record(bootstrap.market).status,
                  )}
                </p>
                <p>
                  Última recepción:{' '}
                  {Number.isSafeInteger(
                    marketState.last_received_at ??
                      record(bootstrap.market).last_received_at,
                  )
                    ? `${new Date(
                        Number(
                          marketState.last_received_at ??
                            record(bootstrap.market).last_received_at,
                        ),
                      ).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`
                    : 'Aún no hay datos recibidos'}
                </p>
                {typeof (
                  marketState.reason ?? record(bootstrap.market).reason
                ) === 'string' && (
                  <p>
                    Detalle del feed:{' '}
                    {String(
                      marketState.reason ?? record(bootstrap.market).reason,
                    )}
                  </p>
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
                <p>Profundidad bid/ask: no expuesta por el DTO de terminal.</p>
                <p>
                  Financiación:{' '}
                  {record(bootstrap.market).funding === 'known_current_interval'
                    ? 'cobertura del período actual disponible; tasa y límites del período no se exponen en esta API.'
                    : 'desconocida; entradas bloqueadas y PnL neto incompleto.'}
                </p>
                {gatewayEngine && !engineOff && (
                  <p>
                    Motor paper:{' '}
                    {paperEngineLabel(gatewayEngineStatus, gatewayEngineReason)}
                  </p>
                )}
                <p>
                  Warm-up:{' '}
                  {engineOff
                    ? 'no aplica: el motor está apagado.'
                    : bootstrap.engine?.status === 'warming'
                      ? 'el motor aún no ha recibido evidencia suficiente.'
                      : 'el conteo de velas de calentamiento no está expuesto.'}
                </p>
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
                <section
                  className="demo-terminal__panel"
                  aria-label="Decisiones del motor"
                >
                  <h2>Análisis recientes</h2>
                  {engineOff ? (
                    <p role="status">
                      Motor de decisiones apagado. Solo se muestran velas y
                      precio públicos de Kraken Futures; no hay análisis, cuenta
                      ni operaciones simuladas.
                    </p>
                  ) : analyses.length ? (
                    analyses
                      .slice(-100)
                      .reverse()
                      .map((item, index) => {
                        const analysis = record(item)
                        const selector = record(analysis.selector)
                        const proposals = Array.isArray(analysis.proposals)
                          ? analysis.proposals
                          : []
                        const analysisId = String(analysis.analysis_id ?? '')
                        return (
                          <article
                            key={String(analysis.analysis_id ?? index)}
                            aria-current={selectedId === analysisId}
                          >
                            {localDemo && (
                              <button
                                type="button"
                                aria-pressed={selectedId === analysisId}
                                aria-label={`Seleccionar análisis ${analysisId}`}
                                onClick={() =>
                                  setSelectedAnalysisId(analysisId)
                                }
                              >
                                Seleccionar análisis
                              </button>
                            )}
                            <strong>
                              {localDemo
                                ? analysisAction(analysis)
                                : String(
                                    selector.action ??
                                      analysis.action ??
                                      'Análisis',
                                  )}
                            </strong>
                            <p>{analysisReason(analysis, localDemo)}</p>
                            {showAnalysisTime && (
                              <p>Hora: {utcTime(analysis.decision_time_ms)}</p>
                            )}
                            <p>
                              Estrategia seleccionada:{' '}
                              {strategyLabel(
                                selector.strategy_id ??
                                  analysis.selected_strategy_id,
                              )}
                            </p>
                            <p>
                              Versión del motor:{' '}
                              {String(
                                analysis.runtime_version ?? 'No disponible',
                              )}
                            </p>
                            <button
                              type="button"
                              className="demo-terminal__present"
                              aria-label={`Copiar ID completo ${analysisId}`}
                              onClick={() =>
                                void navigator.clipboard?.writeText(analysisId)
                              }
                            >
                              Copiar ID de análisis
                            </button>
                            <code className="connected-terminal__hash">
                              {analysisId || 'ID no disponible'}
                            </code>
                            <details>
                              <summary>Propuestas y condiciones</summary>
                              {proposals.map((proposalValue, proposalIndex) => {
                                const proposal = record(proposalValue)
                                const conditions = Array.isArray(
                                  proposal.conditions,
                                )
                                  ? proposal.conditions
                                  : []
                                return (
                                  <div
                                    key={String(
                                      proposal.strategy_id ?? proposalIndex,
                                    )}
                                  >
                                    <strong>
                                      {String(
                                        proposal.strategy_id ?? 'Estrategia',
                                      )}
                                    </strong>
                                    <p>
                                      {String(proposal.action ?? 'WAIT')} ·{' '}
                                      {reasonLabel(proposal.reason_code)}
                                    </p>
                                    {conditions.map(
                                      (conditionValue, conditionIndex) => {
                                        const condition = record(conditionValue)
                                        return (
                                          <small
                                            key={String(
                                              condition.code ?? conditionIndex,
                                            )}
                                          >
                                            {String(
                                              condition.code ?? 'Condición',
                                            )}
                                            :{' '}
                                            {String(
                                              condition.passed === true
                                                ? 'cumplida'
                                                : condition.passed === false
                                                  ? 'no cumplida'
                                                  : 'no disponible',
                                            )}
                                          </small>
                                        )
                                      },
                                    )}
                                  </div>
                                )
                              })}
                            </details>
                          </article>
                        )
                      })
                  ) : (
                    <p>Aún no hay análisis registrados.</p>
                  )}
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
                </section>
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
                  ).map((action) => (
                    <button
                      key={action}
                      type="button"
                      className="demo-terminal__present"
                      disabled={gatewayEngine || !connected || commandPending}
                      onClick={() => {
                        if (
                          action === 'paper.new_run' &&
                          !window.confirm(
                            localDemo
                              ? 'Crear una cuenta/run MOCK nueva que repite el escenario y conservar el historial anterior?'
                              : 'Crear una cuenta/run nuevo y conservar el historial anterior?',
                          )
                        )
                          return
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
                  {commandPending && (
                    <span role="status">
                      Comando enviado; aceptación no significa fill.
                    </span>
                  )}
                  {commandStatus && <p role="status">{commandStatus}</p>}
                </section>
                <details className="connected-terminal__metadata" open>
                  <summary>Cuenta y estado de riesgo</summary>
                  <section className="connected-terminal__panel">
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
                  </section>
                </details>
                <ApprovedPortfolioTables
                  label="CARTERA PAPER · USD / BTC"
                  title="Posiciones y operaciones"
                  ariaLabel="Posiciones paper"
                  open={{
                    title: 'Posición abierta',
                    columns: ['Dirección', 'Cantidad BTC', 'Entrada USD'],
                    emptyLabel: 'Sin posición abierta.',
                    rows: position.side
                      ? [
                          {
                            id: String(state.run_id),
                            cells: [
                              String(position.side),
                              quantity(position.quantity_btc),
                              money(position.entry_price_usd_per_btc),
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
