import { useMemo } from 'react'
import type { Candle, Quote } from '../../domain/market-data'
import { formatChange, formatPrice } from '../format'
import './summary.css'

type BtcEurSummaryProps = {
  readonly quote: Quote | undefined
  readonly candles: readonly Candle[]
}

type CandleStats = {
  high: number
  low: number
  volume: number
}

const PLACEHOLDER = '—'

/**
 * Area F of the main screen: BTC-EUR summary derived from the mock quote and
 * candles. Values the mock cannot provide fall back to an honest placeholder,
 * and the caption never claims a real 24h window over daily mock candles.
 */
export default function BtcEurSummary({ quote, candles }: BtcEurSummaryProps) {
  const stats = useMemo(() => candleStats(candles), [candles])
  const change = quote === undefined ? undefined : formatChange(quote)

  return (
    <section className="summary" aria-label="Resumen BTC-EUR">
      <div className="section-header">
        <div>
          <h2 id="dashboard-summary-title">
            Información general del instrumento en este caso (BTC-EUR)
          </h2>
        </div>
      </div>

      <dl className="summary__grid">
        <div className="summary__cell">
          <dt>Último precio</dt>
          <dd>{quote ? formatPrice(quote.price, 'EUR') : PLACEHOLDER}</dd>
        </div>
        <div className="summary__cell">
          <dt>Variación</dt>
          <dd
            className={
              change
                ? `summary__change summary__change--${change.direction}`
                : ''
            }
          >
            {change ? change.text : PLACEHOLDER}
          </dd>
        </div>
        <div className="summary__cell">
          <dt>Máximo</dt>
          <dd>{stats ? formatPrice(stats.high, 'EUR') : PLACEHOLDER}</dd>
        </div>
        <div className="summary__cell">
          <dt>Mínimo</dt>
          <dd>{stats ? formatPrice(stats.low, 'EUR') : PLACEHOLDER}</dd>
        </div>
        <div className="summary__cell">
          <dt>Volumen</dt>
          <dd>{stats ? formatVolume(stats.volume) : PLACEHOLDER}</dd>
        </div>
      </dl>

      <p className="summary__caption">
        Derivado del histórico mock; no representa 24 h reales.
      </p>
    </section>
  )
}

function candleStats(candles: readonly Candle[]): CandleStats | null {
  if (candles.length === 0) return null
  let high = candles[0]!.high
  let low = candles[0]!.low
  let volume = 0
  for (const candle of candles) {
    high = Math.max(high, candle.high)
    low = Math.min(low, candle.low)
    volume += candle.volume
  }
  return { high, low, volume }
}

function formatVolume(volume: number): string {
  return Math.round(volume).toLocaleString('en-US')
}
