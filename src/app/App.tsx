import { useCallback, useMemo, useState } from 'react'
import BtcEurDashboard from './BtcEurDashboard.tsx'
import { useAlerts } from '../features/alerts/presentation/useAlerts.ts'
import type { AnalysisProvider } from '../domain/analysis.ts'
import type { MarketDataProvider } from '../features/market-data/domain/market-data.ts'
import type { PortfolioRepository } from '../features/portfolio/domain/portfolio.ts'
import type { AlertRepository } from '../features/alerts/domain/alerts.ts'
import { LocalStoragePortfolioRepository } from '../features/portfolio/infrastructure/local-storage-portfolio-repository.ts'
import { LocalStorageAlertRepository } from '../features/alerts/infrastructure/local-storage-alert-repository.ts'
import {
  createMarketDataProvider,
  type MarketDataProviderMode,
} from '../features/market-data/infrastructure/market-data-provider.ts'
import { DeterministicMockMarketDataProvider } from '../features/market-data/infrastructure/deterministic-mock-market-data.ts'
import { GeminiAnalysisProvider } from '../features/analysis/infrastructure/gemini-analysis-provider.ts'
import { MockAnalysisProvider } from '../features/analysis/infrastructure/mock-analysis-provider.ts'
import type { AnalysisMode } from '../features/analysis/presentation/AnalysisModeToggle.tsx'
import GeminiControl from '../features/analysis/presentation/GeminiControl.tsx'
import { resolveMarketDataProviderMode } from '../features/market-data/infrastructure/market-data-provider.ts'
import './App.css'
import DemoShell from './DemoShell.tsx'
import HistoricalRuns from './HistoricalRuns.tsx'
import TerminalEntry from './TerminalEntry.tsx'

type AppProps = {
  provider?: MarketDataProvider
  paperTradingProvider?: MarketDataProvider
  portfolioRepository?: PortfolioRepository
  alertRepository?: AlertRepository
  analysis?: AnalysisProvider
  /** Optional remote Gemini provider. When provided, the AI toggle is enabled. */
  geminiAnalysis?: AnalysisProvider
  /** Test seam: builds the spot provider for the selected mode. */
  marketDataProviderFactory?: (
    mode: MarketDataProviderMode,
  ) => MarketDataProvider
}

type AppContentProps = AppProps & { providerMode: MarketDataProviderMode }

function AppContent({
  provider,
  paperTradingProvider,
  portfolioRepository,
  alertRepository,
  analysis,
  geminiAnalysis,
  marketDataProviderFactory,
  providerMode: configuredProviderMode,
}: AppContentProps) {
  const defaultProvider = useMemo(
    () =>
      marketDataProviderFactory
        ? marketDataProviderFactory(configuredProviderMode)
        : createMarketDataProvider({ mode: configuredProviderMode }),
    [configuredProviderMode, marketDataProviderFactory],
  )
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
      <nav
        className="app__connected-navigation"
        aria-label="Navegación de la aplicación"
      >
        <a href="/terminal">Terminal conectada</a>
      </nav>
      <BtcEurDashboard
        provider={activeProvider}
        labProvider={activeLabProvider}
        portfolioRepository={activePortfolioRepository}
        alerts={alerts}
        analysis={currentAnalysis}
        analysisMode={analysisMode}
        analysisFallback={analysisMode === 'ai' ? activeAnalysis : undefined}
        dataMode={
          provider === undefined && configuredProviderMode === 'kraken'
            ? 'real'
            : 'simulated'
        }
        aiControl={<GeminiControl onEnabledChange={handleGeminiChange} />}
      />
    </main>
  )
}

const PROVIDER_MODE_OPTIONS: Array<{
  mode: MarketDataProviderMode
  label: string
  status: string
}> = [
  { mode: 'mock', label: 'MOCK', status: 'Datos simulados (MOCK)' },
  { mode: 'kraken', label: 'Real (Kraken)', status: 'Datos reales (Kraken)' },
]

/**
 * Spot dashboard with a runtime MOCK/Real switch. The env var only sets the
 * initial mode; switching remounts the dashboard so subscriptions, quotes and
 * alert evaluation never carry over between providers.
 */
function SpotApp(props: AppProps) {
  const [mode, setMode] = useState<MarketDataProviderMode>(() =>
    resolveMarketDataProviderMode(),
  )
  const switchable = props.provider === undefined
  return (
    <>
      {switchable && (
        <div
          role="radiogroup"
          aria-label="Fuente de datos"
          className="app__data-source"
        >
          {PROVIDER_MODE_OPTIONS.map((option) => (
            <label key={option.mode} className="app__data-source-option">
              <input
                type="radio"
                name="market-data-source"
                className="app__data-source-input"
                checked={mode === option.mode}
                onChange={() => setMode(option.mode)}
              />
              <span className="app__data-source-label">{option.label}</span>
            </label>
          ))}
          <span role="status" className="app__data-source-status">
            {
              PROVIDER_MODE_OPTIONS.find((option) => option.mode === mode)
                ?.status
            }
          </span>
        </div>
      )}
      <AppContent key={mode} {...props} providerMode={mode} />
    </>
  )
}

export default function App(props: AppProps) {
  if (window.location.pathname === '/terminal') return <TerminalEntry />
  if (window.location.pathname === '/historicos') return <HistoricalRuns />
  if (
    window.location.pathname === '/demo' ||
    window.location.pathname.startsWith('/demo/')
  )
    return <DemoShell />

  return <SpotApp {...props} />
}
