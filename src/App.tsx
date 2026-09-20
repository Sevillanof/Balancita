import { useMemo, useState } from 'react'
import BtcEurDashboard from './app/BtcEurDashboard'
import AlertNotificationCenter from './app/alerts/AlertNotificationCenter'
import { useAlerts } from './app/alerts/useAlerts'
import type { AnalysisProvider } from './domain/analysis'
import type { MarketDataProvider } from './domain/market-data'
import type { PortfolioRepository } from './domain/portfolio'
import type { AlertRepository } from './domain/alerts'
import { LocalStoragePortfolioRepository } from './portfolio/local-storage-portfolio-repository'
import { LocalStorageAlertRepository } from './alerts/local-storage-alert-repository'
import { createMarketDataProvider } from './providers/market-data-provider'
import { DeterministicMockMarketDataProvider } from './providers/deterministic-mock-market-data'
import { GeminiAnalysisProvider } from './providers/gemini-analysis-provider'
import { MockAnalysisProvider } from './providers/mock-analysis-provider'
import { AnalysisModeToggle } from './app/AnalysisModeToggle'
import type { AnalysisMode } from './app/AnalysisModeToggle'
import './App.css'

type AppProps = {
  provider?: MarketDataProvider
  paperTradingProvider?: MarketDataProvider
  portfolioRepository?: PortfolioRepository
  alertRepository?: AlertRepository
  analysis?: AnalysisProvider
  /** Optional remote Gemini provider. When provided, the AI toggle is enabled. */
  geminiAnalysis?: AnalysisProvider
}

function App({
  provider,
  paperTradingProvider,
  portfolioRepository,
  alertRepository,
  analysis,
  geminiAnalysis,
}: AppProps) {
  const defaultProvider = useMemo(() => createMarketDataProvider(), [])
  const labProvider = useMemo(
    () => new DeterministicMockMarketDataProvider(1),
    [],
  )
  const defaultPortfolioRepository = useMemo(
    () => new LocalStoragePortfolioRepository(),
    [],
  )
  const defaultAlertRepository = useMemo(
    () => new LocalStorageAlertRepository(),
    [],
  )
  const defaultAnalysis = useMemo(() => new MockAnalysisProvider(), [])
  const defaultGeminiAnalysis = useMemo(
    () =>
      new GeminiAnalysisProvider(
        import.meta.env.VITE_GEMINI_SERVER_URL ?? 'http://127.0.0.1:8787',
      ),
    [],
  )
  const activeProvider = provider ?? defaultProvider
  const activeLabProvider = paperTradingProvider ?? labProvider
  const activePortfolioRepository =
    portfolioRepository ?? defaultPortfolioRepository
  const activeAlertRepository = alertRepository ?? defaultAlertRepository
  const activeAnalysis = analysis ?? defaultAnalysis
  const activeGeminiAnalysis = geminiAnalysis ?? defaultGeminiAnalysis
  const alerts = useAlerts(activeProvider, activeAlertRepository)
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('local')

  const currentAnalysis =
    analysisMode === 'ai' ? activeGeminiAnalysis : activeAnalysis

  return (
    <main className="app">
      <header className="app__header">
        <h1>Balancita</h1>
        <p className="tagline">
          Un espacio personal de inversión local y educativo.
        </p>
        <AnalysisModeToggle mode={analysisMode} onChange={setAnalysisMode} />
      </header>

      <AlertNotificationCenter
        triggered={alerts.triggered}
        onAcknowledge={(id) => void alerts.acknowledge(id)}
      />

      <BtcEurDashboard
        provider={activeProvider}
        labProvider={activeLabProvider}
        portfolioRepository={activePortfolioRepository}
        alerts={alerts}
        analysis={currentAnalysis}
        analysisMode={analysisMode}
        analysisFallback={analysisMode === 'ai' ? activeAnalysis : undefined}
        dataMode={
          provider === undefined &&
          import.meta.env.VITE_MARKET_DATA_PROVIDER === 'coinbase'
            ? 'real'
            : 'simulated'
        }
      />
    </main>
  )
}

export default App
