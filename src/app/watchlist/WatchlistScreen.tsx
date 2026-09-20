import type {
  Instrument,
  MarketDataProvider,
  Quote,
} from '../../domain/market-data'
import { formatChange, formatLocalTime, formatPrice } from '../format'
import { useWatchlist } from './useWatchlist'
import './watchlist.css'

type WatchlistScreenProps = {
  provider: MarketDataProvider
  selectedInstrumentId?: Instrument['id']
  onSelectInstrument?: (instrument: Instrument) => void
}

const PLACEHOLDER = '—'

export default function WatchlistScreen({
  provider,
  selectedInstrumentId,
  onSelectInstrument,
}: WatchlistScreenProps) {
  const { status, instruments, quotes, retry } = useWatchlist(provider)

  return (
    <section className="watchlist" aria-label="Watchlist">
      <h2 className="watchlist__title">Watchlist</h2>
      <table className="watchlist__table" aria-busy={status === 'loading'}>
        <caption className="watchlist__caption">
          Realtime prices for your watchlist
        </caption>
        <thead>
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col">Name</th>
            <th scope="col" className="watchlist__num">
              Price
            </th>
            <th scope="col">Currency</th>
            <th scope="col" className="watchlist__num">
              Change
            </th>
            <th scope="col">Status</th>
            <th scope="col" className="watchlist__num">
              Last update
            </th>
          </tr>
        </thead>
        <tbody>
          {status === 'loading' && (
            <tr>
              <td colSpan={7} role="status" className="watchlist__placeholder">
                Loading watchlist…
              </td>
            </tr>
          )}
          {status === 'empty' && (
            <tr>
              <td colSpan={7} role="status" className="watchlist__placeholder">
                No instruments available.
              </td>
            </tr>
          )}
          {status === 'error' && (
            <tr>
              <td colSpan={7} role="status" className="watchlist__placeholder">
                Unable to load market data.
                <button
                  type="button"
                  className="watchlist__retry"
                  onClick={retry}
                >
                  Retry
                </button>
              </td>
            </tr>
          )}
          {status === 'ready' &&
            instruments.map((instrument) => (
              <WatchlistRow
                key={instrument.id}
                instrument={instrument}
                quote={quotes.get(instrument.id)}
                isSelected={instrument.id === selectedInstrumentId}
                onSelect={
                  onSelectInstrument
                    ? () => onSelectInstrument(instrument)
                    : undefined
                }
              />
            ))}
        </tbody>
      </table>
    </section>
  )
}

function WatchlistRow({
  instrument,
  quote,
  isSelected,
  onSelect,
}: {
  instrument: Instrument
  quote: Quote | undefined
  isSelected: boolean
  onSelect?: () => void
}) {
  const hasQuote = quote !== undefined
  const change = hasQuote ? formatChange(quote) : undefined
  const selectable = onSelect !== undefined

  return (
    <tr aria-current={isSelected ? 'true' : undefined}>
      <th scope="row">
        {selectable ? (
          <button
            type="button"
            className="watchlist__symbol"
            aria-pressed={isSelected || undefined}
            onClick={onSelect}
          >
            {instrument.symbol}
          </button>
        ) : (
          instrument.symbol
        )}
      </th>
      <td>{instrument.displayName}</td>
      <td className="watchlist__num watchlist__price">
        {hasQuote ? formatPrice(quote.price, instrument.currency) : PLACEHOLDER}
      </td>
      <td>{instrument.currency}</td>
      <td className="watchlist__num watchlist__change">
        {change ? (
          <span
            className={`watchlist__change--${change.direction}`}
            data-direction={change.direction}
          >
            {change.text}
          </span>
        ) : (
          PLACEHOLDER
        )}
      </td>
      <td>{quote?.status ?? PLACEHOLDER}</td>
      <td className="watchlist__num watchlist__updated">
        {hasQuote ? formatLocalTime(quote.timestamp) : PLACEHOLDER}
      </td>
    </tr>
  )
}
