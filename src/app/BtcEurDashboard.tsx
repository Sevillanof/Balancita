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
import { formatPriceMoney } from '../shared/finance/format.ts'
import './dashboard.css'

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
}: BtcEurDashboardProps) {
  const market = useWatchlist(provider)
  const history = useCandleHistory(provider, 'BTC-EUR')
  const ledger = useTrading(provider, {
    portfolioRepository,
    initialInstrumentId: 'BTC-EUR',
  })
  const news = useNewsStream()
  const [orderFlowSide, setOrderFlowSide] = useState<OrderSide | null>(null)
  const [showSimulations, setShowSimulations] = useState(false)
  const instrument = market.instruments.find(({ id }) => id === 'BTC-EUR')
  const quote =
    instrument === undefined ? undefined : market.quotes.get(instrument.id)
  const eur = ledger.account === null ? undefined : ledger.account.cash.EUR
  const ready = market.status === 'ready' && instrument !== undefined

  return (
    <div className="dashboard">
      <div className="dashboard__grid">
        <header className="dashboard__brand">
          <span className="dashboard__brand-mark" aria-hidden="true" />
          <h1 className="dashboard__brand-title">Balancita (BTC/EUR)</h1>
          {ready && instrument !== undefined && (
            <BtcEurSummary quote={quote} candles={history.candles} />
          )}
        </header>

        <section
          className="dashboard__available"
          aria-label="Dinero disponible"
        >
          <p className="dashboard__eyebrow">Dinero disponible</p>
          <p className="dashboard__available-amount">
            {eur === undefined ? '—' : formatPriceMoney(eur, 'EUR')}
          </p>
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
            <ChartPanel
              status={history.status}
              candles={history.candles}
              quote={quote}
              onRetry={history.retry}
            />
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
              <AutoTradingControl />
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
          onClose={() => setOrderFlowSide(null)}
          onAccountChanged={() => {
            void ledger.refreshAccount()
          }}
        />
      )}
    </div>
  )
}

function OrderFlowDialog({
  side,
  provider,
  portfolioRepository,
  onClose,
  onAccountChanged,
}: {
  side: OrderSide
  provider: MarketDataProvider
  portfolioRepository: PortfolioRepository
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
