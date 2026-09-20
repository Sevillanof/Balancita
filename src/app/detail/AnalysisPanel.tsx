import type { Candle, Instrument, Quote } from '../../domain/market-data'
import type { AnalysisProvider } from '../../domain/analysis'
import type { PortfolioRepository } from '../../domain/portfolio'
import type { AnalysisMode } from '../AnalysisModeToggle'
import { useAnalysis, type AnalysisSource } from './useAnalysis'

type AnalysisPanelProps = {
  mode?: AnalysisMode
  analysis: AnalysisProvider
  /** Local engine used when the primary provider fails. */
  fallback?: AnalysisProvider
  portfolioRepository: PortfolioRepository
  instrument: Instrument
  quote: Quote | undefined
  candles: readonly Candle[]
}

function sourceLabel(
  mode: AnalysisMode,
  source: AnalysisSource,
): string | null {
  if (mode === 'local') return 'Mock'
  if (source === 'preferred') return 'Gemini'
  if (source === 'fallback') return 'Mock'
  return null
}

export default function AnalysisPanel({
  mode = 'local',
  analysis,
  fallback,
  portfolioRepository,
  instrument,
  quote,
  candles,
}: AnalysisPanelProps) {
  const { status, result, error, source, warning, analyze } = useAnalysis({
    analysis,
    fallback,
    portfolioRepository,
    instrument,
    quote,
    candles,
  })
  const waitingForQuote = quote === undefined
  const busy = status === 'loading'
  const label = sourceLabel(mode, source)

  return (
    <section
      className="detail__analysis"
      aria-label={`${instrument.symbol} analysis`}
    >
      <h3 className="detail__analysis-title">
        {mode === 'ai' ? 'AI analysis' : 'Local analysis'}
      </h3>
      <button
        type="button"
        className="detail__analyze"
        onClick={() => void analyze()}
        disabled={waitingForQuote || busy}
        title={waitingForQuote ? 'Waiting for a price quote.' : undefined}
      >
        Analyze
      </button>
      {busy && (
        <p role="status" aria-busy="true" className="analysis__note">
          Analyzing current quote…
        </p>
      )}
      {status === 'error' && (
        <p role="alert" className="analysis__note">
          Unable to analyze: {error}. Click Analyze to retry.
        </p>
      )}
      {warning !== null && (
        <p role="alert" className="analysis__note analysis__note--warning">
          {warning}
        </p>
      )}
      {status === 'ready' && result !== null && (
        <div
          className="analysis__result"
          data-classification={result.classification}
        >
          {label !== null && (
            <p className="analysis__source">Source: {label}</p>
          )}
          <p className="analysis__verdict">
            Verdict:{' '}
            <span
              className={`analysis__badge analysis__badge--${result.classification}`}
            >
              {result.classification}
            </span>
          </p>
          <p className="analysis__metric">
            Volatility (ATR):{' '}
            {result.volatility.averageTrueRangePercent.toFixed(2)}% over{' '}
            {result.volatility.lookbackCandles} candle
            {result.volatility.lookbackCandles === 1 ? '' : 's'} (
            {result.volatility.level}).
          </p>
          <ul className="analysis__list" aria-label="Analysis reasons">
            {result.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {result.warnings.length > 0 && (
            <ul
              className="analysis__list analysis__list--warnings"
              aria-label="Analysis warnings"
            >
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
