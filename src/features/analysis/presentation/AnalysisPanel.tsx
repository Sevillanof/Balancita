import type {
  Candle,
  Instrument,
  Quote,
} from '../../market-data/domain/market-data.ts'
import type { AnalysisProvider } from '../../../domain/analysis.ts'
import type { PortfolioRepository } from '../../portfolio/domain/portfolio.ts'
import type { AnalysisMode } from './AnalysisModeToggle.tsx'
import { useAnalysis, type AnalysisSource } from './useAnalysis.ts'

type AnalysisPanelProps = {
  mode?: AnalysisMode
  analysis: AnalysisProvider
  /** Local engine used when the primary provider fails. */
  fallback?: AnalysisProvider
  portfolioRepository: PortfolioRepository
  instrument: Instrument
  quote: Quote | undefined
  candles: readonly Candle[]
  automatic?: boolean
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

function classificationLabel(classification: string): string {
  return classification === 'watch'
    ? 'Vigilar'
    : classification === 'review'
      ? 'Revisar'
      : 'Neutral'
}

function recommendationLabel(recommendation: string): string {
  return recommendation === 'buy'
    ? 'Comprar'
    : recommendation === 'sell'
      ? 'Vender'
      : 'Mantener'
}

function volatilityLabel(level: string): string {
  return level === 'high' ? 'Alta' : level === 'moderate' ? 'Moderada' : 'Baja'
}

function formatAge(ageMs: number): string {
  if (ageMs < 1000) return 'menos de un segundo'
  const seconds = Math.floor(ageMs / 1000)
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min`
}

export default function AnalysisPanel({
  mode = 'local',
  analysis,
  fallback,
  portfolioRepository,
  instrument,
  quote,
  candles,
  automatic = false,
}: AnalysisPanelProps) {
  const { status, result, source, warning, analyze, metadata, stale, ageMs } =
    useAnalysis({
      analysis,
      fallback,
      portfolioRepository,
      instrument,
      quote,
      candles,
      automatic,
    })
  const waitingForQuote = quote === undefined
  const busy = status === 'loading'
  const label = sourceLabel(mode, source)

  return (
    <section
      className="detail__analysis"
      aria-label={`Análisis de ${instrument.symbol}`}
    >
      <h3 className="detail__analysis-title">
        {mode === 'ai' ? 'Análisis con IA' : 'Análisis local'}
      </h3>
      <button
        type="button"
        className="detail__analyze"
        onClick={() => void analyze()}
        disabled={waitingForQuote || busy}
        title={waitingForQuote ? 'Esperando una cotización.' : undefined}
      >
        Analizar
      </button>
      {busy && (
        <p role="status" aria-busy="true" className="analysis__note">
          Analizando la cotización actual…
        </p>
      )}
      {status === 'error' && (
        <p role="alert" className="analysis__note">
          No se pudo completar el análisis. Intente nuevamente.
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
            <p className="analysis__source">Fuente: {label}</p>
          )}
          <p className="analysis__verdict">
            Clasificación:{' '}
            <span
              className={`analysis__badge analysis__badge--${result.classification}`}
            >
              {classificationLabel(result.classification)}
            </span>
          </p>
          <p className="analysis__recommendation">
            Recomendación educativa:{' '}
            <strong>{recommendationLabel(result.recommendation)}</strong>
          </p>
          {metadata !== null && (
            <p className="analysis__metadata">
              Precio usado: {metadata.quotePrice.toLocaleString('en-US')} ·{' '}
              {metadata.candleCount}{' '}
              {metadata.candleCount === 1 ? 'vela' : 'velas'} · Datos{' '}
              {metadata.quoteStatus === 'mock'
                ? 'simulados'
                : metadata.quoteStatus === 'stale'
                  ? 'desactualizados'
                  : 'reales'}
              {' · '}Antigüedad: {formatAge(ageMs ?? 0)}
              {stale ? ' · Resultado desactualizado' : ''}
            </p>
          )}
          <p className="analysis__metric">
            Volatilidad (ATR):{' '}
            {result.volatility.averageTrueRangePercent.toFixed(2)}% en{' '}
            {result.volatility.lookbackCandles}{' '}
            {result.volatility.lookbackCandles === 1 ? 'vela' : 'velas'} (
            {volatilityLabel(result.volatility.level)}).
          </p>
          <ul className="analysis__list" aria-label="Razones del análisis">
            {result.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {result.warnings.length > 0 && (
            <ul
              className="analysis__list analysis__list--warnings"
              aria-label="Advertencias del análisis"
            >
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <p className="analysis__disclaimer">{result.disclaimer}</p>
        </div>
      )}
    </section>
  )
}
