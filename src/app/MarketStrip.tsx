import {
  productName,
  productPair,
} from '../features/trading-view/domain/product-label.ts'
import { money } from './terminal-labels.ts'
import TerminalNotices from './TerminalNotices.tsx'

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
      className="mt-0 mr-0 mb-1.5 ml-0 flex flex-wrap items-baseline gap-x-4 gap-y-0.5"
      aria-label={`Mercado ${productPair(product ?? 'PF_ETHUSD')}`}
    >
      <h1 className="m-0 text-brand-compact font-semibold">
        {productName(product)}{' '}
        <span className="font-medium text-ink-2">/ Dólar</span>
        <small className="ml-2.5 font-brand-mono text-label leading-normal font-medium tracking-market text-ink-2">
          perpetuo
        </small>
      </h1>
      <strong className="font-brand-mono text-brand-compact font-semibold">
        {money(displayedPrice)}
      </strong>
      {typeof change24h === 'number' && (
        <span
          className={`font-brand-mono text-note leading-normal ${change24h >= 0 ? 'text-long' : 'text-short'}`}
          data-tone={change24h >= 0 ? 'ok' : 'bad'}
        >
          {change24h >= 0 ? '+' : ''}
          {change24h.toLocaleString('es-ES', {
            maximumFractionDigits: 2,
          })}
          % 24 h
        </span>
      )}
      <span className="text-hint text-ink-2" title={eventTimes ?? undefined}>
        <span>{quoteLabel}</span>
        {mode === 'paper_live' && quoteReceivedAt !== null && (
          <span>
            {` · hace ${Math.floor(Math.max(0, displayClock - quoteReceivedAt) / 1_000)} s`}
          </span>
        )}
      </span>
      {alerts.length > 0 && (
        <TerminalNotices items={alerts} label="Avisos" compact />
      )}
    </section>
  )
}
