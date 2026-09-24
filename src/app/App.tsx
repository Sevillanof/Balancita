import { useCallback, useMemo, useState } from 'react'
import BtcEurDashboard from './BtcEurDashboard.tsx'
import { useAlerts } from '../features/alerts/presentation/useAlerts.ts'
import type { AnalysisProvider } from '../domain/analysis.ts'
import type { MarketDataProvider } from '../features/market-data/domain/market-data.ts'
import type { PortfolioRepository } from '../features/portfolio/domain/portfolio.ts'
import type { AlertRepository } from '../features/alerts/domain/alerts.ts'
import { LocalStoragePortfolioRepository } from '../features/portfolio/infrastructure/local-storage-portfolio-repository.ts'
import { LocalStorageAlertRepository } from '../features/alerts/infrastructure/local-storage-alert-repository.ts'
import { createMarketDataProvider } from '../features/market-data/infrastructure/market-data-provider.ts'
import { DeterministicMockMarketDataProvider } from '../features/market-data/infrastructure/deterministic-mock-market-data.ts'
import { GeminiAnalysisProvider } from '../features/analysis/infrastructure/gemini-analysis-provider.ts'
import { MockAnalysisProvider } from '../features/analysis/infrastructure/mock-analysis-provider.ts'
import type { AnalysisMode } from '../features/analysis/presentation/AnalysisModeToggle.tsx'
import GeminiControl from '../features/analysis/presentation/GeminiControl.tsx'
import { resolveMarketDataProviderMode } from '../features/market-data/infrastructure/market-data-provider.ts'
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
  const handleGeminiChange = useCallback((enabled: boolean) => {
    setAnalysisMode(enabled ? 'ai' : 'local')
  }, [])

  const currentAnalysis =
    analysisMode === 'ai' ? activeGeminiAnalysis : activeAnalysis

  return (
    <main className="app">
      <GeminiControl onEnabledChange={handleGeminiChange} />
      <BtcEurDashboard
        provider={activeProvider}
        labProvider={activeLabProvider}
        portfolioRepository={activePortfolioRepository}
        alerts={alerts}
        analysis={currentAnalysis}
        analysisMode={analysisMode}
        analysisFallback={analysisMode === 'ai' ? activeAnalysis : undefined}
        dataMode={
          provider === undefined && resolveMarketDataProviderMode() === 'kraken'
            ? 'real'
            : 'simulated'
        }
      />
    </main>
  )
}

export default App
