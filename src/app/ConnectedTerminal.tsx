import { useEffect, useMemo, useState } from 'react'
import ApprovedTerminalChart, {
  type ApprovedTerminalMarker,
} from '../features/trading-view/presentation/ApprovedTerminalChart.tsx'
import {
  loadConnectedSnapshot,
  loadPaperDecisions,
  type ConnectedSnapshot,
  type PaperDecisionEvent,
} from '../features/connected-trading/infrastructure/connected-trading-provider.ts'
import PaperDecisionPanel from '../features/connected-trading/presentation/PaperDecisionPanel.tsx'
import { paperDecisionReasonLabel } from '../features/connected-trading/presentation/decision-labels.ts'
import ApprovedTerminalLayout from '../features/trading-view/presentation/ApprovedTerminalLayout.tsx'
import ApprovedTradingHeader from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'
import ApprovedMarketRow from '../features/trading-view/presentation/ApprovedMarketRow.tsx'
import ApprovedChartToolbar from '../features/trading-view/presentation/ApprovedChartToolbar.tsx'
import ApprovedPortfolioTables from '../features/trading-view/presentation/ApprovedPortfolioTables.tsx'
import ApprovedChartLegend from '../features/trading-view/presentation/ApprovedChartLegend.tsx'
import './DemoShell.css'
import './ConnectedTerminal.css'

const REFRESH_MS = 5_000
const EUR = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
})
const BTC = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 8 })
const INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 } as const

export default function ConnectedTerminal() {
  const [snapshot, setSnapshot] = useState<ConnectedSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [interval, setInterval] = useState<keyof typeof INTERVALS>('1m')
  const [clock, setClock] = useState(0)
  const [decisions, setDecisions] = useState<PaperDecisionEvent[]>([])
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [decisionReceivedAt, setDecisionReceivedAt] = useState<number | null>(
    null,
  )
  const [decisionRetry, setDecisionRetry] = useState(0)
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(
    null,
  )

  useEffect(() => {
    const timer = globalThis.setInterval(() => setClock(Date.now()), REFRESH_MS)
    return () => globalThis.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const fresh = await loadConnectedSnapshot({ signal: controller.signal })
        if (!cancelled) {
          setSnapshot(fresh)
          setClock(Date.now())
          setError(null)
        }
      } catch (cause) {
        if (!cancelled && !controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'No se pudieron cargar los datos conectados.',
          )
      } finally {
        if (!cancelled)
          timer = globalThis.setTimeout(() => void refresh(), REFRESH_MS)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      controller.abort()
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }, [retry])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const fresh = await loadPaperDecisions({ signal: controller.signal })
        if (!cancelled) {
          setDecisions([
            ...new Map(
              fresh.map((decision) => [decision.id, decision]),
            ).values(),
          ])
          setDecisionReceivedAt(Date.now())
          setDecisionError(null)
        }
      } catch (cause) {
        if (!cancelled && !controller.signal.aborted)
          setDecisionError(
            cause instanceof Error
              ? cause.message
              : 'No se pudieron cargar las decisiones paper.',
          )
      } finally {
        if (!cancelled)
          timer = globalThis.setTimeout(() => void refresh(), REFRESH_MS)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      controller.abort()
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }, [retry, decisionRetry])

  const candles = useMemo(() => {
    const seconds = INTERVALS[interval]
    const buckets = new Map<
      number,
      {
        time: number
        open: number
        high: number
        low: number
        close: number
        volume: number
      }
    >()
    for (const candle of (snapshot?.candles ?? []).filter(
      (item) => item.timestamp + 60_000 <= clock,
    )) {
      const time = Math.floor(candle.timestamp / 1000 / seconds) * seconds
      const current = buckets.get(time)
      if (!current)
        buckets.set(time, {
          time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        })
      else {
        current.high = Math.max(current.high, candle.high)
        current.low = Math.min(current.low, candle.low)
        current.close = candle.close
        current.volume += candle.volume
      }
    }
    return [...buckets.values()]
  }, [snapshot, interval, clock])

  const decisionMarkers = useMemo(() => {
    const seconds = INTERVALS[interval]
    const candleTimes = new Set(candles.map((candle) => Number(candle.time)))
    return decisions.flatMap((decision): ApprovedTerminalMarker[] => {
      const bucket = Math.floor(decision.eventTime / 1000 / seconds) * seconds
      if (!candleTimes.has(bucket)) return []
      const label =
        decision.outcome === 'pending'
          ? 'PEND'
          : decision.outcome === 'hold'
            ? 'ESPERA'
            : decision.outcome === 'gate-rejected'
              ? 'RECHAZO'
              : 'ABSTENCIÓN'
      return [
        {
          id: decision.id,
          time: decision.eventTime / 1000,
          type: 'decision',
          direction: decision.direction,
          label,
          decisionStatus: decision.outcome,
        },
      ]
    })
  }, [candles, decisions, interval])
  const selectedDecision = decisions.find(
    (decision) => decision.id === selectedDecisionId,
  )

  const newest = snapshot?.candles
    .filter((item) => item.timestamp + 60_000 <= clock)
    .at(-1)
  const candleCloseTime = newest ? newest.timestamp + 60_000 : null
  const freshness = candleCloseTime
  const ageMs =
    freshness === undefined || freshness === null
      ? null
      : Math.max(0, clock - freshness)
  const stale = error !== null || ageMs === null || ageMs > 120_000

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
              {snapshot
                ? error
                  ? 'SIN CONEXIÓN · PAPER'
                  : 'CONECTADO · PAPER'
                : error
                  ? 'SIN CONEXIÓN'
                  : 'CONECTANDO'}
            </span>
            <span
              className={
                stale
                  ? 'connected-terminal__stale'
                  : 'demo-shell__engine-status'
              }
            >
              {stale ? 'Datos desactualizados' : 'Datos recientes'}
            </span>
            <a className="demo-shell__existing-link" href="/">
              Aplicación actual
            </a>
          </>
        }
      />
      <div className="demo-shell__disclaimer">
        Observación de BTC/EUR desde datos del backend. Las órdenes paper son
        simuladas; no se conectan a un exchange.
      </div>
      <main className="demo-shell__main connected-terminal__main">
        <div className="demo-shell__page-heading">
          <p className="demo-shell__eyebrow">BALANCITA TRADER VIEW</p>
          <h1>Terminal</h1>
        </div>
        <ApprovedMarketRow
          identity={
            <div>
              <p className="demo-shell__eyebrow">
                MERCADO · BTC/EUR · DATOS PAPER
              </p>
              <h2>
                Bitcoin <span>/ Euro</span>
              </h2>
            </div>
          }
          quote={
            <div className="demo-terminal__quote">
              <strong>
                {newest ? EUR.format(newest.close) : 'No disponible'}
              </strong>
              <span>
                Última vela ·{' '}
                {newest
                  ? new Date(newest.timestamp).toLocaleTimeString('es-ES', {
                      timeZone: 'UTC',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'No disponible'}{' '}
                UTC
              </span>
            </div>
          }
          context={
            <div className="demo-terminal__clock">
              <span>
                {stale ? 'Datos desactualizados' : 'Datos recientes'} · Kraken
              </span>
              <details>
                <summary>Proveniencia y horas UTC</summary>
                <p>
                  Última vela:{' '}
                  {newest && candleCloseTime !== null
                    ? `${new Date(newest.timestamp).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC · cierre estimado ${new Date(candleCloseTime).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`
                    : 'No disponible'}
                </p>
                <p>
                  Recepción:{' '}
                  {snapshot
                    ? `${new Date(snapshot.receivedAt).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`
                    : 'No disponible'}
                </p>
                <p>Precio de referencia de vela; no es una cotización tick.</p>
                <p>
                  Historia nativa de 1 minuto, reagrupada solo para
                  visualización.
                </p>
              </details>
            </div>
          }
        />
        {error && (
          <div className="connected-terminal__error" role="alert">
            <span>
              {snapshot
                ? 'Se conserva la última lectura; la conexión está desactualizada.'
                : `No se pudo cargar la terminal conectada: ${error}`}
            </span>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Reintentar
            </button>
          </div>
        )}
        {!snapshot && !error && (
          <p
            className="connected-terminal__state"
            role="status"
            aria-busy="true"
          >
            Conectando con el backend…
          </p>
        )}
        {snapshot && (
          <>
            <ApprovedTerminalLayout
              chart={
                <section
                  className="demo-terminal__panel"
                  aria-label="Gráfico de velas BTC-EUR"
                >
                  <ApprovedChartToolbar
                    instrument="BTC/EUR"
                    description="Velas japonesas / Volumen"
                    controls={
                      <div
                        className="demo-terminal__intervals"
                        role="group"
                        aria-label="Intervalo del gráfico"
                      >
                        {Object.keys(INTERVALS).map((value) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={interval === value}
                            onClick={() =>
                              setInterval(value as keyof typeof INTERVALS)
                            }
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    }
                  />
                  <ApprovedTerminalChart
                    candles={candles}
                    markers={decisionMarkers}
                    selectedId={selectedDecisionId ?? ''}
                    intervalSeconds={INTERVALS[interval]}
                    initialViewport="approved-terminal"
                    onSelect={(time, markerId) => {
                      if (markerId) setSelectedDecisionId(markerId)
                      else {
                        const inBucket = decisions.filter(
                          (decision) =>
                            Math.floor(
                              decision.eventTime / 1000 / INTERVALS[interval],
                            ) *
                              INTERVALS[interval] ===
                            time,
                        )
                        if (inBucket.length === 1)
                          setSelectedDecisionId(inBucket[0]!.id)
                      }
                    }}
                  />
                  {candles.length === 0 && (
                    <p role="status">No hay velas BTC-EUR disponibles.</p>
                  )}
                  <ApprovedChartLegend>
                    <span>Decisiones del motor</span>
                    <span>
                      Marcadores = eventos de decisión; no son ejecuciones.
                    </span>
                    <small>
                      Desplazamiento y zoom disponibles en el gráfico
                    </small>
                  </ApprovedChartLegend>
                </section>
              }
              decisions={
                <PaperDecisionPanel
                  decisions={decisions}
                  selectedId={selectedDecisionId}
                  error={decisionError}
                  receivedAt={decisionReceivedAt}
                  onRetry={() => setDecisionRetry((value) => value + 1)}
                  onSelect={(decision) => {
                    setSelectedDecisionId(decision.id)
                    document
                      .querySelector('[data-testid="approved-chart-renderer"]')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }}
                />
              }
            />
            {selectedDecision && (
              <p className="demo-terminal__selection">
                <strong>Decisión seleccionada</strong>
                <span>
                  {eventTime(selectedDecision.eventTime)} UTC ·{' '}
                  {selectedDecision.reasonCode === null
                    ? (selectedDecision.reason ?? 'No disponible')
                    : paperDecisionReasonLabel(selectedDecision.reasonCode)}
                </span>
              </p>
            )}
            <details className="connected-terminal__metadata">
              <summary>Estado del motor y cuenta paper</summary>
              <section
                className="connected-terminal__panel"
                aria-label="Estado del motor paper"
              >
                <h2>Estado del motor</h2>
                <p>
                  <strong>Simulación paper</strong> · estrategia TypeScript
                  nativa · conexión{' '}
                  {snapshot.paper.stream_state ?? 'No disponible'}
                </p>
                <p>
                  {snapshot.paper.enabled && snapshot.paper.running
                    ? 'Activo según el backend'
                    : snapshot.paper.enabled
                      ? 'No activo'
                      : 'Deshabilitado'}
                </p>
                <p>
                  Colector OHLC:{' '}
                  {snapshot.collector.running === true
                    ? 'Activo'
                    : snapshot.collector.running === false
                      ? 'Pausado'
                      : 'No disponible'}
                </p>
                <h3>Cuenta paper</h3>
                <dl>
                  <dt>Saldo EUR</dt>
                  <dd>{amount(snapshot.paper.account.balance_eur)}</dd>
                  <dt>BTC</dt>
                  <dd>{bitcoin(snapshot.paper.account.btc_balance)}</dd>
                  <dt>Patrimonio</dt>
                  <dd>{amount(snapshot.paper.account.total_equity_eur)}</dd>
                  <dt>Resultado cerrado</dt>
                  <dd>
                    {amount(snapshot.paper.execution_summary.closed_pnl_eur)}
                  </dd>
                </dl>
                <small>
                  Valores y métricas provienen del motor; no se recalculan en el
                  navegador.
                </small>
              </section>
            </details>
            {decisionError && (
              <p role="alert">
                No se pudo actualizar el registro de decisiones: {decisionError}
              </p>
            )}
            <ApprovedPortfolioTables
              label="CARTERA PAPER"
              title="Posiciones y operaciones"
              ariaLabel="Posiciones paper"
              open={{
                title: 'Posiciones abiertas',
                columns: [
                  'Estrategia',
                  'Entrada',
                  'Importe',
                  'Precio actual',
                  'PnL no realizado',
                ],
                emptyLabel: 'No hay posiciones abiertas.',
                rows: snapshot.positions.open.map((position) => ({
                  id: String(position.id),
                  cells: [
                    String(position.strategy_id ?? 'No disponible'),
                    price(position.entry_price),
                    amount(position.amount_eur),
                    price(position.current_price),
                    amount(position.unrealized_net_pnl_eur),
                  ],
                })),
              }}
              closed={{
                title: 'Operaciones cerradas',
                columns: [
                  'Estrategia',
                  'Entrada',
                  'Salida',
                  'Importe',
                  'Comisiones',
                  'PnL neto',
                ],
                emptyLabel: 'No hay posiciones cerradas.',
                rows: snapshot.positions.closed.map((position) => ({
                  id: String(position.id),
                  cells: [
                    String(position.strategy_id ?? 'No disponible'),
                    eventTime(position.entry_time),
                    eventTime(position.exit_time),
                    amount(position.amount_eur),
                    amount(position.fee_eur),
                    amount(position.net_pnl_eur),
                  ],
                })),
              }}
            />
            <details className="connected-terminal__metadata">
              <summary>Órdenes y resumen por estrategia</summary>
              <section
                className="connected-terminal__panel"
                aria-label="Órdenes paper"
              >
                <h2>Órdenes y ejecuciones</h2>
                {snapshot.orders.length === 0 ? (
                  <p>No hay órdenes registradas.</p>
                ) : (
                  <div className="connected-terminal__table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Hora de señal (UTC)</th>
                          <th>Estrategia</th>
                          <th>Acción</th>
                          <th>Estado</th>
                          <th>Importe</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.orders.map((order) => (
                          <tr key={String(order.id)}>
                            <td>{eventTime(order.signalTimestamp)}</td>
                            <td>
                              {String(order.strategyId ?? 'No disponible')}
                            </td>
                            <td>{String(order.action ?? 'No disponible')}</td>
                            <td>
                              {order.executionTimestamp === null
                                ? order.gatePassed === false
                                  ? 'Rechazada por gate'
                                  : 'Sin ejecución confirmada'
                                : 'Ejecución registrada'}
                            </td>
                            <td>{amount(order.amountEur)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section
                className="connected-terminal__panel"
                aria-label="Resumen de estrategias"
              >
                <h2>Resumen por estrategia</h2>
                <p>
                  Agregados del backend; no son un registro de motivos de
                  decisión.
                </p>
                {snapshot.summary.length === 0 ? (
                  <p>No disponible.</p>
                ) : (
                  <div className="connected-terminal__table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Estrategia</th>
                          <th>Señales (resumen)</th>
                          <th>Rechazos de gate (resumen)</th>
                          <th>PnL neto cerrado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.summary.map((row) => (
                          <tr key={String(row.strategy_id)}>
                            <td>
                              {String(
                                row.name ?? row.strategy_id ?? 'No disponible',
                              )}
                            </td>
                            <td>{amount(row.total_signals)}</td>
                            <td>{amount(row.gate_rejections)}</td>
                            <td>{amount(row.net_pnl_eur)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </details>
          </>
        )}
      </main>
    </div>
  )
}

function amount(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? EUR.format(value)
    : 'No disponible'
}
function price(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? EUR.format(value)
    : 'No disponible'
}
function bitcoin(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${BTC.format(value)} BTC`
    : 'No disponible'
}
function eventTime(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleString('es-ES', { timeZone: 'UTC' })
      : 'No disponible'
  }
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 'No disponible'
  const ms = value < 100_000_000_000 ? value * 1000 : value
  return new Date(ms).toLocaleString('es-ES', { timeZone: 'UTC' })
}
