import { useEffect, useMemo, useState } from 'react'
import type { CandlestickData, SeriesMarker, Time } from 'lightweight-charts'
import PriceChart from '../features/price-chart/presentation/PriceChart.tsx'
import {
  loadConnectedSnapshot,
  loadPaperDecisions,
  type ConnectedSnapshot,
  type PaperDecisionEvent,
} from '../features/connected-trading/infrastructure/connected-trading-provider.ts'
import PaperDecisionPanel from '../features/connected-trading/presentation/PaperDecisionPanel.tsx'
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
          setDecisions(fresh)
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
  }, [retry])

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
    return [...buckets.values()].map((candle): CandlestickData<Time> => ({
      ...candle,
      time: candle.time as Time,
    }))
  }, [snapshot, interval, clock])

  const decisionMarkers = useMemo(() => {
    const seconds = INTERVALS[interval]
    const candleTimes = new Set(candles.map((candle) => Number(candle.time)))
    return decisions.flatMap((decision): SeriesMarker<Time>[] => {
      const bucket = Math.floor(decision.eventTime / 1000 / seconds) * seconds
      if (!candleTimes.has(bucket)) return []
      const selected = selectedDecisionId === decision.id
      return [
        {
          time: bucket as Time,
          position: decision.direction === 'long' ? 'belowBar' : 'aboveBar',
          color:
            decision.outcome === 'gate-rejected'
              ? '#d8a34a'
              : selected
                ? '#45d6a5'
                : '#8a9aaa',
          shape: decision.direction === 'long' ? 'arrowUp' : 'circle',
          text: selected
            ? 'Decisión seleccionada'
            : decisionOutcomeLabel(decision.outcome),
        },
      ]
    })
  }, [candles, decisions, interval, selectedDecisionId])

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
      <header className="demo-shell__header">
        <div className="demo-shell__header-inner">
          <a
            className="demo-shell__brand"
            href="/"
            aria-label="Balancita, volver a la aplicación"
          >
            balancita<span className="demo-shell__brand-period">.</span>
          </a>
          <nav
            className="demo-shell__navigation"
            aria-label="Navegación conectada"
          >
            <a
              className="demo-shell__nav-link"
              href="/terminal"
              aria-current="page"
            >
              Terminal
            </a>
            <a className="demo-shell__nav-link" href="/historicos">
              Pruebas históricas
            </a>
            <a className="demo-shell__nav-link" href="/">
              Aplicación
            </a>
          </nav>
          <div className="demo-shell__status">
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
          </div>
        </div>
      </header>
      <main className="demo-shell__main connected-terminal__main">
        <div className="demo-shell__page-heading">
          <p className="demo-shell__eyebrow">BALANCITA · MODO CONECTADO</p>
          <h1>Terminal BTC-EUR</h1>
        </div>
        <section
          className="connected-terminal__market"
          aria-label="Mercado BTC-EUR"
        >
          <div>
            <span>BTC / EUR</span>
            <strong>
              {newest ? EUR.format(newest.close) : 'No disponible'}
            </strong>
          </div>
          <p>
            Último cierre de vela · fuente Kraken · no es una cotización tick
          </p>
          <p>
            {newest && candleCloseTime !== null
              ? `Apertura de última vela: ${new Date(newest.timestamp).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC · cierre estimado de minuto: ${new Date(candleCloseTime).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`
              : 'Hora de vela: No disponible'}
          </p>
          <p>
            {snapshot
              ? `Respuesta recibida: ${new Date(snapshot.receivedAt).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`
              : 'Respuesta recibida: No disponible'}
          </p>
        </section>
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
            <div className="connected-terminal__layout">
              <section
                className="connected-terminal__panel"
                aria-label="Gráfico de velas BTC-EUR"
              >
                <div className="connected-terminal__panel-heading">
                  <h2>Precio BTC-EUR</h2>
                  <div aria-label="Intervalo visual">
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
                </div>
                <PriceChart data={candles} markers={decisionMarkers} />
                {candles.length === 0 && (
                  <p role="status">No hay velas BTC-EUR disponibles.</p>
                )}
                <p className="connected-terminal__note">
                  Historia nativa de 1 minuto, reagrupada solo para
                  visualización. Los motivos no registrados aparecen como “No
                  disponible”.
                </p>
              </section>
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
            </div>
            {decisionError && (
              <p role="alert">
                No se pudo actualizar el registro de decisiones: {decisionError}
              </p>
            )}
            <PaperDecisionPanel
              decisions={decisions}
              selectedId={selectedDecisionId}
              onSelect={(decision) => {
                setSelectedDecisionId(decision.id)
                document
                  .querySelector('[data-testid="price-chart"]')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }}
            />
            <section
              className="connected-terminal__panel"
              aria-label="Posiciones paper"
            >
              <h2>Posiciones abiertas</h2>
              {snapshot.positions.open.length === 0 ? (
                <p>No hay posiciones abiertas.</p>
              ) : (
                <div className="connected-terminal__table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Estrategia</th>
                        <th>Entrada</th>
                        <th>Importe</th>
                        <th>Precio actual</th>
                        <th>PnL no realizado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.positions.open.map((position) => (
                        <tr key={String(position.id)}>
                          <td>
                            {String(position.strategy_id ?? 'No disponible')}
                          </td>
                          <td>{price(position.entry_price)}</td>
                          <td>{amount(position.amount_eur)}</td>
                          <td>{price(position.current_price)}</td>
                          <td>{amount(position.unrealized_net_pnl_eur)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section
              className="connected-terminal__panel"
              aria-label="Posiciones cerradas"
            >
              <h2>Posiciones cerradas</h2>
              {snapshot.positions.closed.length === 0 ? (
                <p>No hay posiciones cerradas.</p>
              ) : (
                <div className="connected-terminal__table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Estrategia</th>
                        <th>Entrada</th>
                        <th>Salida</th>
                        <th>Importe</th>
                        <th>Comisiones</th>
                        <th>PnL neto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.positions.closed.map((position) => (
                        <tr key={String(position.id)}>
                          <td>
                            {String(position.strategy_id ?? 'No disponible')}
                          </td>
                          <td>{eventTime(position.entry_time)}</td>
                          <td>{eventTime(position.exit_time)}</td>
                          <td>{amount(position.amount_eur)}</td>
                          <td>{amount(position.fee_eur)}</td>
                          <td>{amount(position.net_pnl_eur)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
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
                          <td>{String(order.strategyId ?? 'No disponible')}</td>
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

function decisionOutcomeLabel(outcome: PaperDecisionEvent['outcome']): string {
  switch (outcome) {
    case 'abstained':
      return 'Abstención'
    case 'gate-rejected':
      return 'Gate rechazado'
    case 'pending':
      return 'Pendiente'
    case 'hold':
      return 'Sin cambio'
  }
}
