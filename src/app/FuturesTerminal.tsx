import { useEffect, useRef, useState } from 'react'
import ApprovedTerminalLayout from '../features/trading-view/presentation/ApprovedTerminalLayout.tsx'
import ApprovedTradingHeader from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'
import ApprovedMarketRow from '../features/trading-view/presentation/ApprovedMarketRow.tsx'
import ApprovedPortfolioTables from '../features/trading-view/presentation/ApprovedPortfolioTables.tsx'
import ApprovedTerminalChart, {
  type ApprovedTerminalCandle,
} from '../features/trading-view/presentation/ApprovedTerminalChart.tsx'
import {
  parseTerminalEnvelope,
  terminalWebSocketUrl,
  type TerminalBootstrap,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { applyTerminalEvent } from '../features/connected-trading/infrastructure/terminal-state.ts'
import './DemoShell.css'
import './ConnectedTerminal.css'

type ViewState = Record<string, unknown>

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function money(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
    return 'No disponible'
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(value))
}

function quantity(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))
    return 'No disponible'
  return `${value} BTC`
}

function reasonLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    return 'Motivo no registrado'
  const known: Record<string, string> = {
    c27_long_breakout: 'Ruptura alcista C27',
    c27_short_breakout: 'Ruptura bajista C27',
    position_owned: 'La posición sigue bajo gestión de su estrategia',
    owner_exit_condition_not_met: 'La condición de salida no se ha activado',
    entry_conditions_not_met: 'No se cumplen las condiciones de entrada',
  }
  return known[value] ?? value.replaceAll('_', ' ')
}

function TerminalMarketChart({ market }: { market: Record<string, unknown> }) {
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
    market.schema_version !== 'mock-terminal-market.v1' ||
    candles.length === 0
  )
    return <p>El snapshot no contiene velas BTC/USD verificables.</p>
  return (
    <>
      <p>
        Velas cerradas del fixture del runtime MOCK · actualización por
        WebSocket.
      </p>
      <ApprovedTerminalChart
        candles={candles}
        markers={[]}
        selectedId=""
        intervalSeconds={Number(market.interval_ms) / 1000}
        currency="USD"
        instrument="BTC/USD perpetuo"
        initialViewport="approved-terminal"
        onSelect={() => undefined}
      />
    </>
  )
}

export default function FuturesTerminal({
  bootstrap,
}: {
  bootstrap: TerminalBootstrap
}) {
  const [state, setState] = useState<ViewState | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commandPending, setCommandPending] = useState(false)
  const [commandStatus, setCommandStatus] = useState('')
  const [commandVersion, setCommandVersion] = useState(0)
  const socketRef = useRef<WebSocket | null>(null)

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
      socket = new WebSocket(terminalWebSocketUrl())
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
                  run_id: bootstrap.active_run_id,
                  last_seq: lastSeq,
                }
              : {
                  schema_version: 1,
                  type: 'subscribe',
                  run_id: bootstrap.active_run_id,
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
          const watermark = event.data.watermark as number
          streamId = event.stream_id
          lastSeq = watermark
          seen.clear()
          const market = record(event.data.market)
          const snapshotState = record(event.data.state)
          setState({
            ...snapshotState,
            terminal_market:
              market.schema_version === 'mock-terminal-market.v1'
                ? market
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
          setCommandStatus(
            `Resultado durable recibido: ${String(result.status ?? 'registrado')}.`,
          )
        }
        if (event.type === 'protocol.error') {
          setCommandPending(false)
          setError(
            `Comando rechazado por el servidor: ${String(event.data.code ?? 'error')}`,
          )
          return
        }
        if (
          event.run_id !== bootstrap.active_run_id ||
          seen.has(event.event_id)
        )
          return
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
  }, [bootstrap])

  const account = record(state?.account)
  const position = record(state?.position)
  const market = record(state?.terminal_market)
  const candles = Array.isArray(market.candles) ? market.candles : []
  const lastCandle = record(candles.at(-1))
  const displayedPrice = position.mark_usd_per_btc ?? lastCandle.close
  const analyses = Array.isArray(state?.analyses) ? state.analyses : []
  const orders = Array.isArray(state?.orders) ? state.orders : []

  const sendCommand = (action: string) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN || !bootstrap || !state)
      return
    setCommandPending(true)
    setCommandStatus('Enviando comando; aceptación no significa fill.')
    socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        run_id: bootstrap.active_run_id,
        command_id: crypto.randomUUID(),
        expected_state_version: Number(commandVersion),
        action,
      }),
    )
    setCommandVersion((version) => version + 1)
  }

  const modeLabel =
    bootstrap?.mode === 'mock'
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
            <span className="demo-shell__badge">
              {connected ? 'FLUJO CONECTADO' : 'SIN CONEXIÓN'}
            </span>
            <span>{modeLabel}</span>
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
                KRAKEN FUTURES · BTC/USD PERPETUO
              </p>
              <h2>
                Bitcoin <span>/ Dólar</span>
              </h2>
            </div>
          }
          quote={
            <div className="demo-terminal__quote">
              <strong>{money(displayedPrice)}</strong>
              <span>
                {position.mark_usd_per_btc !== undefined
                  ? 'Precio de marca · USD/BTC'
                  : 'Último cierre del fixture · USD/BTC'}
              </span>
            </div>
          }
          context={
            <div>
              <span>
                {connected
                  ? 'Eventos WebSocket recibidos'
                  : 'Esperando WebSocket'}
              </span>
              <p>Run: {bootstrap?.active_run_id ?? 'cargando'}</p>
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
            <ApprovedTerminalLayout
              chart={
                <section
                  className="demo-terminal__panel"
                  aria-label="Gráfico BTC/USD"
                >
                  <h2>BTC/USD perpetuo</h2>
                  <TerminalMarketChart market={market} />
                  <p>
                    Las cifras de cuenta y decisiones siguientes provienen del
                    snapshot/eventos durables.
                  </p>
                </section>
              }
              decisions={
                <section
                  className="demo-terminal__panel"
                  aria-label="Decisiones del motor"
                >
                  <h2>Análisis recientes</h2>
                  {analyses.length ? (
                    analyses
                      .slice(-100)
                      .reverse()
                      .map((item, index) => {
                        const analysis = record(item)
                        const selector = record(analysis.selector)
                        const selectedProposal = (
                          Array.isArray(analysis.proposals)
                            ? analysis.proposals
                            : []
                        ).find(
                          (proposal) =>
                            record(proposal).strategy_id ===
                            (selector.strategy_id ??
                              analysis.selected_strategy_id),
                        )
                        const proposals = Array.isArray(analysis.proposals)
                          ? analysis.proposals
                          : []
                        const reasonCodes = Array.isArray(analysis.reason_codes)
                          ? analysis.reason_codes
                          : []
                        const analysisId = String(analysis.analysis_id ?? '')
                        return (
                          <article key={String(analysis.analysis_id ?? index)}>
                            <strong>
                              {String(
                                selector.action ??
                                  analysis.action ??
                                  'Análisis',
                              )}
                            </strong>
                            <p>
                              {reasonLabel(
                                selector.reason_code ??
                                  record(selectedProposal).reason_code ??
                                  reasonCodes[0] ??
                                  analysis.reason_code,
                              )}
                            </p>
                            <p>
                              Estrategia seleccionada:{' '}
                              {String(
                                selector.strategy_id ??
                                  analysis.selected_strategy_id ??
                                  analysis.strategy_id ??
                                  'No registrada',
                              )}
                            </p>
                            <button
                              type="button"
                              className="demo-terminal__present"
                              onClick={() =>
                                void navigator.clipboard?.writeText(analysisId)
                              }
                            >
                              Copiar ID {analysisId.slice(0, 8)}
                            </button>
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
                </section>
              }
            />
            <section
              className="connected-terminal__panel"
              aria-label="Controles paper"
            >
              <h2>Controles simulados</h2>
              {(
                [
                  'paper.start',
                  'paper.pause',
                  'paper.resume',
                  'paper.close',
                  'paper.new_run',
                ] as const
              ).map((action) => (
                <button
                  key={action}
                  type="button"
                  className="demo-terminal__present"
                  disabled={!connected || commandPending}
                  onClick={() => {
                    if (
                      action === 'paper.new_run' &&
                      !window.confirm(
                        'Crear una cuenta/run nuevo y conservar el historial anterior?',
                      )
                    )
                      return
                    sendCommand(action)
                  }}
                >
                  {
                    {
                      'paper.start': 'Iniciar simulación',
                      'paper.pause': 'Pausar entradas',
                      'paper.resume': 'Reanudar entradas',
                      'paper.close': 'Cerrar posición',
                      'paper.new_run': 'Nueva cuenta/run',
                    }[action]
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
                  <dd>{money(account.equity_usd)}</dd>
                  <dt>Fees USD</dt>
                  <dd>{money(account.fees_usd)}</dd>
                  <dt>Funding</dt>
                  <dd>
                    {account.funding_complete === true
                      ? money(account.funding_paid_usd ?? account.funding_paid)
                      : 'Incompleto · neto no disponible'}
                  </dd>
                  <dt>PnL neto</dt>
                  <dd>
                    {(account.net_usd ?? account.net_complete) == null
                      ? account.funding_complete === true
                        ? 'No disponible durante posición abierta'
                        : 'Incompleto'
                      : money(account.net_usd ?? account.net_complete)}
                  </dd>
                  <dt>Posición</dt>
                  <dd>
                    {position.side
                      ? `${String(position.side)} · ${quantity(position.quantity_btc)}`
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
                        `${String(order.quantity_btc ?? 'Cantidad no disponible')} · ${String(order.order_id ?? 'ID no disponible')}`,
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
      </main>
    </div>
  )
}
