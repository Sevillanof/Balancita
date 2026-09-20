import type {
  Instrument,
  MarketDataProvider,
  Quote,
} from '../../domain/market-data'
import {
  formatChange,
  formatLocalTime,
  formatPrice,
  formatQuoteStatus,
} from '../format'
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
    <section className="watchlist" aria-label="Lista de seguimiento">
      <h2 className="watchlist__title">Lista de seguimiento</h2>
      <table className="watchlist__table" aria-busy={status === 'loading'}>
        <caption className="watchlist__caption">
          Precios en tiempo real de tu lista de seguimiento
        </caption>
        <thead>
          <tr>
            <th scope="col">Símbolo</th>
            <th scope="col">Nombre</th>
            <th scope="col" className="watchlist__num">
              Precio
            </th>
            <th scope="col">Moneda</th>
            <th scope="col" className="watchlist__num">
              Variación
            </th>
            <th scope="col">Estado</th>
            <th scope="col" className="watchlist__num">
              Última actualización
            </th>
          </tr>
        </thead>
        <tbody>
          {status === 'loading' && (
            <tr>
              <td colSpan={7} role="status" className="watchlist__placeholder">
                Cargando lista de seguimiento…
              </td>
            </tr>
          )}
          {status === 'empty' && (
            <tr>
              <td colSpan={7} role="status" className="watchlist__placeholder">
                No hay instrumentos disponibles.
              </td>
            </tr>
          )}
          {status === 'error' && (
            <tr>
              <td colSpan={7} role="status" className="watchlist__placeholder">
                No se pudieron cargar los datos de mercado.
                <button
                  type="button"
                  className="watchlist__retry"
                  onClick={retry}
                >
                  Reintentar
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
      <td>{quote ? formatQuoteStatus(quote.status) : PLACEHOLDER}</td>
      <td className="watchlist__num watchlist__updated">
        {hasQuote ? formatLocalTime(quote.timestamp) : PLACEHOLDER}
      </td>
    </tr>
  )
}
