import type { Candle, Instrument, Quote } from '../../domain/market-data'
import type { AnalysisProvider } from '../../domain/analysis'
import type { PortfolioRepository } from '../../domain/portfolio'
import { useAnalysis } from './useAnalysis'

type AnalysisPanelProps = {
  analysis: AnalysisProvider
  portfolioRepository: PortfolioRepository
  instrument: Instrument
  quote: Quote | undefined
  candles: readonly Candle[]
}

export default function AnalysisPanel({
  analysis,
  portfolioRepository,
  instrument,
  quote,
  candles,
}: AnalysisPanelProps) {
  const { status, result, error, analyze } = useAnalysis({
    analysis,
    portfolioRepository,
    instrument,
    quote,
    candles,
  })
  const waitingForQuote = quote === undefined
  const busy = status === 'loading'

  return (
    <section
      className="detail__analysis"
      aria-label={`${instrument.symbol} analysis`}
    >
      <h3 className="detail__analysis-title">Local analysis</h3>
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
      {status === 'ready' && result !== null && (
        <div
          className="analysis__result"
          data-classification={result.classification}
        >
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
