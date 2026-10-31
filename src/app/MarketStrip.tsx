import {
  productName,
  productPair,
  productBase,
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
  compact = false,
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
  compact?: boolean
}) {
  const [noticesOpen, setNoticesOpen] = useState(false)
  const age =
    mode === 'paper_live' && quoteReceivedAt !== null
      ? ` · hace ${Math.floor(Math.max(0, displayClock - quoteReceivedAt) / 1000)} s`
      : ''
  if (compact)
    return (
      <>
        <section
          className="grid min-w-0 justify-items-end gap-0.5"
          aria-label={`Mercado ${productPair(product ?? 'PF_ETHUSD')}`}
        >
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <h1 className="m-0 text-label font-medium text-ink-2">
              {productBase(product ?? 'PF_ETHUSD')} / USD
            </h1>
            <strong className="font-brand-mono text-body leading-tight from-1100:text-brand-compact">
              {money(displayedPrice)}
            </strong>
          </div>
          <div className="flex min-w-0 items-center justify-end gap-1.5">
            <span
              className="text-badge leading-tight text-ink-2"
              title={[quoteLabel, eventTimes].filter(Boolean).join(' · ')}
            >
              {quoteLabel.split(' · ')[0]}
              {age}
            </span>
            {alerts.length > 0 && (
              <button
                type="button"
                onClick={() => setNoticesOpen(true)}
                aria-label={`Ver ${alerts.length} aviso${alerts.length === 1 ? '' : 's'} de mercado`}
                className={`cursor-pointer border-0 bg-transparent p-0 text-label ${alerts.some((item) => item.tone === 'bad') ? 'text-short' : 'text-warn'}`}
                title={alerts.map((item) => item.text).join(' · ')}
              >
                ⚠ {alerts.length}
              </button>
            )}
          </div>
        </section>
        {noticesOpen && (
          <ModalFrame
            label="Avisos del mercado"
            onClose={() => setNoticesOpen(false)}
          >
            <h2>Avisos del mercado</h2>
            <TerminalNotices items={alerts} label="Avisos" />
            {eventTimes && <p>{eventTimes}</p>}
            <p>
              {quoteLabel}
              {age}
            </p>
            <button type="button" onClick={() => setNoticesOpen(false)}>
              Cerrar
            </button>
          </ModalFrame>
        )}
      </>
    )
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
import { useState } from 'react'
import ModalFrame from '../features/strategy-lab/presentation/ModalFrame.tsx'
