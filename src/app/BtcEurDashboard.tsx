import { useEffect, useRef, useState } from 'react'
import type { AnalysisProvider } from '../domain/analysis.ts'
import type { MarketDataProvider } from '../features/market-data/domain/market-data.ts'
import type { PortfolioRepository } from '../features/portfolio/domain/portfolio.ts'
import {
  BUY,
  SELL,
  type OrderSide,
} from '../features/paper-trading/domain/orders.ts'
import type { AnalysisMode } from '../features/analysis/presentation/AnalysisModeToggle.tsx'
import ChartPanel from '../features/price-chart/presentation/ChartPanel.tsx'
import FastReplaySection from './FastReplaySection.tsx'
import { useCandleHistory } from '../features/analysis/presentation/useCandleHistory.ts'
import NewsPanel from '../features/news/presentation/NewsPanel.tsx'
import { useNewsStream } from '../features/news/presentation/useNewsStream.ts'
import SimulationsSection from '../features/simulations/presentation/SimulationsSection.tsx'
import BtcEurSummary from '../features/analysis/presentation/summary/BtcEurSummary.tsx'
import AutoTradingControl from '../features/paper-trading/presentation/AutoTradingControl.tsx'
import TradeScreen from '../features/paper-trading/presentation/TradeScreen.tsx'
import { useTrading } from '../features/paper-trading/presentation/useTrading.ts'
import { useWatchlist } from '../features/market-data/presentation/useWatchlist.ts'
import type { UseAlertsResult } from '../features/alerts/presentation/useAlerts.ts'
import {
  formatPrice,
  formatPriceMoney,
  formatQuantity,
} from '../shared/finance/format.ts'
import type { OrderReceipt } from '../features/paper-trading/domain/orders.ts'
import {
  aggregateClosed15mCandles,
  SIMULATED_BTC_EUR_FEE_POLICY,
} from '../features/paper-trading/domain/ema-macd-momentum.ts'
import './dashboard.css'
import { useMemo } from 'react'
import { usePaperTelemetry } from './usePaperTelemetry.ts'
import { paperOrderMarkers } from './paper-order-markers.ts'

const MOMENTUM_SIMULATOR_OPTIONS = {
  feePolicy: SIMULATED_BTC_EUR_FEE_POLICY,
} as const

type BtcEurDashboardProps = {
  provider: MarketDataProvider
  labProvider: MarketDataProvider
  portfolioRepository: PortfolioRepository
  alerts: UseAlertsResult
  analysis: AnalysisProvider
  analysisMode: AnalysisMode
  analysisFallback?: AnalysisProvider
  dataMode: 'real' | 'simulated'
}

/**
 * Main screen: a desktop-first CSS grid that renders ONLY the six wireframe
 * areas A–F while preserving the local paper ledger. Secondary surfaces (instrument detail,
 * portfolio, alerts, mock lab, intelligence status) are intentionally not part
 * of the Phase 1 screen and live in their own modules and tests.
 *
 * Area E is a flat three-button bar (Comprar / Vender / Auto Trade). The full
 * paper-trading flow lives in a dialog opened by Comprar or Vender, so the bar
 * stays exactly three buttons and the existing TradeScreen logic is untouched.
 *
 * The `labProvider`, `alerts`, `analysis*` and `dataMode` props remain wired by
 * the app shell but are unused here; later phases reattach those surfaces.
 */
export default function BtcEurDashboard({
  provider,
  portfolioRepository,
  dataMode,
}: BtcEurDashboardProps) {
  const market = useWatchlist(provider)
  const history = useCandleHistory(provider, 'BTC-EUR')
  const strategySeed = aggregateClosed15mCandles(history.candles)
  const ledger = useTrading(provider, {
    portfolioRepository,
    initialInstrumentId: 'BTC-EUR',
    strategySeed,
    simulatorOptions: MOMENTUM_SIMULATOR_OPTIONS,
  })
  const news = useNewsStream()
  const [orderFlowSide, setOrderFlowSide] = useState<OrderSide | null>(null)
  const [showOrderHistory, setShowOrderHistory] = useState(false)
  const balanceButtonRef = useRef<HTMLButtonElement>(null)
  const [showSimulations, setShowSimulations] = useState(false)
  const [chartMode, setChartMode] = useState<'realtime' | 'fast'>('realtime')
  const paper = usePaperTelemetry()
  const loadedTimes = useMemo(
    () =>
      new Set(
        history.candles.map(({ time }) => Math.floor(Date.parse(time) / 1000)),
      ),
    [history.candles],
  )
  const paperMarkers = useMemo(
    () => paperOrderMarkers(paper.orders, loadedTimes),
    [paper.orders, loadedTimes],
  )
  const instrument = market.instruments.find(({ id }) => id === 'BTC-EUR')
  const quote =
    instrument === undefined ? undefined : market.quotes.get(instrument.id)
  const eur = ledger.account === null ? undefined : ledger.account.cash.EUR
  const orderHistory = ledger.account?.history ?? []
  const ready = market.status === 'ready' && instrument !== undefined

  return (
    <div className="dashboard">
      <DashboardServiceStatus
        dataMode={dataMode}
        connectionStatus={market.connectionStatus}
        quote={quote}
        historyStatus={history.status}
        historyReceivedAtMs={history.historyReceivedAtMs}
        lastCandleTime={history.candles.at(-1)?.time ?? null}
        stream={news.stream}
      />
      <div className="dashboard__grid">
        <header className="dashboard__brand">
          <span className="dashboard__brand-mark" aria-hidden="true" />
          <h1 className="dashboard__brand-title">Balancita (BTC/EUR)</h1>
          {ready && instrument !== undefined && (
            <BtcEurSummary quote={quote} candles={history.candles} />
          )}
        </header>
        <section
          className="paper-telemetry"
          aria-label="Estado de paper trading"
        >
          <span
            className={`paper-telemetry__status paper-telemetry__status--${paper.status?.stream_state === 'connected' ? 'connected' : paper.status?.stream_state === 'rest_polling_1m' ? 'polling' : paper.status?.stream_state === 'failed' ? 'failed' : 'neutral'}`}
          >
            {paper.status?.stream_state ?? 'Sin datos'}
          </span>
          <span>
            Saldo{' '}
            {paper.status
              ? formatPrice(paper.status.account.balance_eur, 'EUR')
              : '—'}
          </span>
          <span>
            Patrimonio{' '}
            {paper.status
              ? formatPrice(paper.status.account.total_equity_eur, 'EUR')
              : '—'}
          </span>
          <span>
            Rechazos {paper.status?.execution_summary.gate_rejections ?? '—'}
          </span>
          <span>
            Ejecuciones {paper.status?.execution_summary.executed_trades ?? '—'}
          </span>
          {paper.error !== null && (
            <span role="status">Estado temporalmente desactualizado</span>
          )}
        </section>

        <section
          className="dashboard__available"
          aria-label="Dinero disponible"
        >
          <p className="dashboard__eyebrow">Dinero disponible</p>
          <button
            ref={balanceButtonRef}
            type="button"
            className="dashboard__available-amount"
            aria-expanded={showOrderHistory}
            aria-controls="dashboard-order-history"
            onClick={() => setShowOrderHistory((visible) => !visible)}
          >
            {eur === undefined ? '—' : formatPriceMoney(eur, 'EUR')}
          </button>
          {showOrderHistory && (
            <OrderHistoryPopover
              history={orderHistory}
              onClose={() => {
                setShowOrderHistory(false)
                balanceButtonRef.current?.focus()
              }}
            />
          )}
        </section>

        {market.status === 'loading' && <GridState kind="loading" />}
        {market.status === 'error' && (
          <GridState kind="error" onRetry={market.retry} />
        )}
        {(market.status === 'empty' ||
          (market.status === 'ready' && instrument === undefined)) && (
          <GridState kind="empty" />
        )}

        {ready && instrument !== undefined && (
          <>
            <section className="dashboard__chart-surface">
              <div
                role="group"
                aria-label="Modo de gráfico"
                className="dashboard__chart-mode"
              >
                <button
                  type="button"
                  aria-pressed={chartMode === 'realtime'}
                  onClick={() => setChartMode('realtime')}
                >
                  Tiempo Real
                </button>
                <button
                  type="button"
                  aria-pressed={chartMode === 'fast'}
                  onClick={() => setChartMode('fast')}
                >
                  Fast Replay Histórico
                </button>
              </div>
              {chartMode === 'realtime' ? (
                <ChartPanel
                  status={history.status}
                  candles={history.candles}
                  quote={quote}
                  onRetry={history.retry}
                  markers={paperMarkers}
                />
              ) : (
                <FastReplaySection />
              )}
            </section>
            <NewsPanel status={news.status} items={news.items} />
            <div
              className="dashboard__actions"
              role="group"
              aria-label="Acciones de trading"
            >
              <button
                type="button"
                className="button button--primary"
                onClick={() => setOrderFlowSide(BUY)}
              >
                Comprar
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setOrderFlowSide(SELL)}
              >
                Vender
              </button>
              <AutoTradingControl
                enabled={ledger.autoTradingEnabled}
                available={
                  market.connectionStatus === 'connected' &&
                  ledger.strategyReady
                }
                ready={ledger.strategyReady}
                onChange={ledger.setAutoTrading}
              />
              <button
                type="button"
                className="button button--secondary"
                aria-expanded={showSimulations}
                aria-controls="simulaciones"
                onClick={() => setShowSimulations((visible) => !visible)}
              >
                Simulaciones
              </button>
            </div>
          </>
        )}
      </div>

      {ready && instrument !== undefined && showSimulations && (
        <div id="simulaciones">
          <SimulationsSection />
        </div>
      )}

      {ready && instrument !== undefined && orderFlowSide !== null && (
        <OrderFlowDialog
          side={orderFlowSide}
          provider={provider}
          portfolioRepository={portfolioRepository}
          simulatorOptions={{ feePolicy: SIMULATED_BTC_EUR_FEE_POLICY }}
          onClose={() => setOrderFlowSide(null)}
          onAccountChanged={() => {
            void ledger.refreshAccount()
          }}
        />
      )}
    </div>
  )
}

function OrderHistoryPopover({
  history,
  onClose,
}: {
  history: readonly OrderReceipt[]
  onClose: () => void
}) {
  const popoverRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    popoverRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      ref={popoverRef}
      id="dashboard-order-history"
      className="dashboard__order-history"
      role="region"
      aria-label="Historial de órdenes"
      tabIndex={-1}
    >
      <h2>Historial de órdenes</h2>
      {history.length === 0 ? (
        <p>Aún no hay órdenes de compra o venta.</p>
      ) : (
        <ul>
          {[...history].reverse().map((order) => (
            <li key={order.id}>
              <strong>{order.side === BUY ? 'Comprar' : 'Vender'}</strong>{' '}
              <span>{order.instrumentId}</span>
              <span>{formatQuantity(order.quantity)}</span>
              <span>{formatPriceMoney(order.total, 'EUR')}</span>
              <span>
                {order.status === 'executed' ? 'Ejecutada' : 'Rechazada'}
              </span>
              <time dateTime={new Date(order.executedAt).toISOString()}>
                {new Date(order.executedAt).toLocaleString('es-ES')}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DashboardServiceStatus({
  dataMode,
  connectionStatus,
  quote,
  historyStatus,
  historyReceivedAtMs,
  lastCandleTime,
  stream,
}: {
  dataMode: 'real' | 'simulated'
  connectionStatus: string
  quote:
    import('../features/market-data/domain/market-data.ts').Quote | undefined
  historyStatus: string
  historyReceivedAtMs: number | null
  lastCandleTime: string | null
  stream: import('../features/news/presentation/useIntelligenceStream.ts').UseIntelligenceStreamResult
}) {
  const snapshot = stream.snapshot
  const collector = snapshot?.market ?? null
  return (
    <section
      className="dashboard__service-status"
      aria-label="Estado de servicios"
    >
      <div>
        <strong>Gráfico · {dataMode === 'real' ? 'Kraken' : 'Simulado'}</strong>
        <span>{marketConnectionLabel(connectionStatus)}</span>
        <small>
          {quote === undefined
            ? 'Esperando la primera cotización'
            : quote.eventTime
              ? `Evento: ${formatServiceTime(quote.eventTime)} · recepción navegador: ${formatServiceTime(quote.receivedTime ?? quote.displayTime ?? quote.timestamp)}`
              : `Marca simulada: ${formatServiceTime(quote.timestamp)}`}
        </small>
      </div>
      <div>
        <strong>Historial REST</strong>
        <span>{historyStatusLabel(historyStatus)}</span>
        <small>
          {historyReceivedAtMs === null
            ? 'Última carga correcta: —'
            : `Última carga correcta: ${formatServiceTime(historyReceivedAtMs)}`}
          {lastCandleTime === null
            ? ' · Última vela: —'
            : ` · Marca de mercado: ${formatServiceTime(lastCandleTime)}`}
        </small>
      </div>
      <div>
        <strong>Transporte SSE navegador</strong>
        <span>
          {streamStatusLabel(stream.transportStatus, stream.error?.message)}
        </span>
        <small>
          {stream.clientReceivedAtMs === null
            ? 'Último evento recibido: —'
            : `Último evento recibido en navegador: ${formatServiceTime(stream.clientReceivedAtMs)}`}
        </small>
      </div>
      <div>
        <strong>Colector del servidor</strong>
        <span>
          {collectorLabel(snapshot?.pipeline.connection ?? 'unavailable')}
        </span>
        <small>
          {collector === null
            ? 'Sin snapshot de mercado'
            : `Evento: ${formatServiceTime(collector.eventTime)} · recepción servidor: ${formatServiceTime(collector.receivedTime)} · snapshot: ${formatServiceTime(collector.displayTime)}`}
        </small>
      </div>
    </section>
  )
}

function marketConnectionLabel(status: string): string {
  return (
    (
      {
        mock: 'Feed simulado activo',
        connecting: 'Conectando WebSocket',
        connected: 'WebSocket conectado',
        reconnecting: 'WebSocket reconectando',
        stale: 'Última cotización obsoleta',
        stopped: 'WebSocket detenido',
      } satisfies Record<string, string>
    )[status] ?? status
  )
}

function historyStatusLabel(status: string): string {
  return (
    (
      {
        loading: 'Cargando',
        ready: 'Disponible',
        empty: 'Sin velas',
        error: 'Error de carga',
      } satisfies Record<string, string>
    )[status] ?? status
  )
}

function streamStatusLabel(status: string, error?: string): string {
  const label =
    (
      {
        connecting: 'Conectando',
        connected: 'Conectado',
        reconnecting: 'Reconectando',
        disabled: 'Deshabilitado',
      } satisfies Record<string, string>
    )[status] ?? status
  return error === undefined ? label : `${label} · ${error}`
}

function collectorLabel(status: string): string {
  return (
    (
      {
        disabled: 'Deshabilitado',
        connecting: 'Conectando',
        connected: 'Conectado',
        reconnecting: 'Reconectando',
        stale: 'Datos obsoletos',
        stopped: 'Detenido',
        unavailable: 'No disponible',
      } satisfies Record<string, string>
    )[status] ?? status
  )
}

function formatServiceTime(value: string | number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-ES')
}

function OrderFlowDialog({
  side,
  provider,
  portfolioRepository,
  simulatorOptions,
  onClose,
  onAccountChanged,
}: {
  side: OrderSide
  provider: MarketDataProvider
  portfolioRepository: PortfolioRepository
  simulatorOptions: Partial<
    import('../features/paper-trading/domain/orders.ts').OrderSimulatorConfig
  >
  onClose: () => void
  onAccountChanged: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null || dialog.open) return
    if (typeof dialog.showModal === 'function') {
      dialog.showModal()
    } else {
      // jsdom and older engines lack showModal; the `open` attribute still
      // exposes the flow while keeping the bar clean.
      dialog.setAttribute('open', '')
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="dashboard__order-dialog"
      aria-label="Operar BTC-EUR"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="dashboard__order-dialog-bar">
        <button
          type="button"
          className="dashboard__order-close"
          onClick={onClose}
        >
          Cerrar
        </button>
      </div>
      <TradeScreen
        provider={provider}
        portfolioRepository={portfolioRepository}
        initialInstrumentId="BTC-EUR"
        initialSide={side}
        onAccountChanged={onAccountChanged}
        simulatorOptions={simulatorOptions}
      />
    </dialog>
  )
}

function GridState({
  kind,
  onRetry,
}: {
  kind: 'loading' | 'error' | 'empty'
  onRetry?: () => void
}) {
  return (
    <section className="dashboard__state" aria-label="Estado del dashboard">
      {kind === 'loading' && (
        <p role="status" aria-busy="true">
          Cargando BTC-EUR…
        </p>
      )}
      {kind === 'error' && (
        <>
          <p role="alert">
            No se pudo cargar BTC-EUR. La fuente de datos no está disponible.
          </p>
          {onRetry !== undefined && (
            <button
              type="button"
              className="button button--secondary"
              onClick={onRetry}
            >
              Reintentar
            </button>
          )}
        </>
      )}
      {kind === 'empty' && (
        <p role="status">
          BTC-EUR no está disponible en la fuente seleccionada.
        </p>
      )}
    </section>
  )
}
