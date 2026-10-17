import {
  productBase,
  productPair,
} from '../features/trading-view/domain/product-label.ts'
import { money } from './terminal-labels.ts'

export default function MarketStrip({
  product,
  mode,
  displayedPrice,
  change24h,
  eventTimes,
  quoteLabel,
  quoteReceivedAt,
  displayClock,
  alerts,
}: {
  product?: string
  mode: string
  displayedPrice: unknown
  change24h: unknown
  eventTimes: string | null
  quoteLabel: string
  quoteReceivedAt: number | null
  displayClock: number
  alerts: Array<{ key: string; tone?: string; text: string }>
}) {
  return (
    <section
      className="connected-terminal__strip"
      aria-label={`Mercado ${productPair(product)}`}
    >
      <h1>
        {product && productBase(product) !== 'BTC'
          ? productBase(product)
          : 'Bitcoin'}{' '}
        <span>/ Dólar</span>
        <small>{`${product ?? 'PF_XBTUSD'} · perpetuo`}</small>
      </h1>
      <strong className="connected-terminal__price">
        {money(displayedPrice)}
      </strong>
      {typeof change24h === 'number' && (
        <span
          className="connected-terminal__change"
          data-tone={change24h >= 0 ? 'ok' : 'bad'}
        >
          {change24h >= 0 ? '+' : ''}
          {change24h.toLocaleString('es-ES', {
            maximumFractionDigits: 2,
          })}
          % 24 h
        </span>
      )}
      <span
        className="connected-terminal__quote-label"
        title={eventTimes ?? undefined}
      >
        <span>{quoteLabel}</span>
        {mode === 'paper_live' && quoteReceivedAt !== null && (
          <span>
            {` · hace ${Math.floor(Math.max(0, displayClock - quoteReceivedAt) / 1_000)} s`}
          </span>
        )}
      </span>
      {alerts.length > 0 && (
        <ul
          className="connected-terminal__chips connected-terminal__alerts"
          aria-label="Avisos"
        >
          {alerts.map((item) => (
            <li key={item.key} data-tone={item.tone}>
              {item.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
