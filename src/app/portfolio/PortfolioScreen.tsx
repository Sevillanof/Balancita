import { useEffect, useRef, useState } from 'react'
import type {
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../../domain/market-data'
import type { Holding, PortfolioRepository } from '../../domain/portfolio'
import {
  costOf,
  profitLossOf,
  profitLossPercentOf,
  valueOf,
} from '../../portfolio/valuation'
import {
  formatPrice,
  formatQuantity,
  formatSignedAmount,
  formatSignedPercent,
} from '../format'
import { usePortfolio } from './usePortfolio'
import './portfolio.css'

type PortfolioScreenProps = {
  provider: MarketDataProvider
  repository: PortfolioRepository
}

type Editing = { mode: 'add' } | { mode: 'edit'; holding: Holding }

const PLACEHOLDER = '—'

export default function PortfolioScreen({
  provider,
  repository,
}: PortfolioScreenProps) {
  const portfolio = usePortfolio(provider, repository)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [pendingDelete, setPendingDelete] = useState<InstrumentId | null>(null)

  const heldIds = new Set(
    portfolio.holdings.map((holding) => holding.instrumentId),
  )
  const catalog = [...portfolio.instruments.values()]

  const handleAdd = async (holding: Holding): Promise<boolean> => {
    const added = await portfolio.add(holding)
    if (added) setEditing(null)
    return added
  }

  const handleEdit = async (holding: Holding): Promise<boolean> => {
    const updated = await portfolio.add(holding)
    if (updated) setEditing(null)
    return updated
  }

  const handleConfirmDelete = async () => {
    if (pendingDelete === null) return
    const removed = await portfolio.remove(pendingDelete)
    if (removed) setPendingDelete(null)
  }

  const { status, loadError } = portfolio

  return (
    <section className="portfolio" aria-label="Portfolio">
      <div className="portfolio__header">
        <h2 className="portfolio__title">Portfolio</h2>
        {status !== 'loading' && status !== 'error' && (
          <button
            type="button"
            className="portfolio__add"
            onClick={() => setEditing({ mode: 'add' })}
          >
            Add position
          </button>
        )}
      </div>

      {status === 'error' && (
        <div role="alert" className="portfolio__error">
          {loadError === 'corrupt'
            ? 'Stored portfolio data could not be read.'
            : 'Unable to load portfolio.'}
          <div className="portfolio__error-actions">
            {loadError === 'corrupt' && (
              <button
                type="button"
                className="portfolio__retry"
                onClick={() => void portfolio.reset()}
              >
                Reset portfolio
              </button>
            )}
            <button
              type="button"
              className="portfolio__retry"
              onClick={portfolio.retry}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {editing && status !== 'error' && (
        <HoldingForm
          key={editing.mode === 'edit' ? editing.holding.instrumentId : 'add'}
          instruments={catalog}
          heldInstrumentIds={heldIds}
          initial={editing.mode === 'edit' ? editing.holding : undefined}
          onSubmit={editing.mode === 'edit' ? handleEdit : handleAdd}
          operationError={portfolio.operationError}
          onCancel={() => setEditing(null)}
        />
      )}

      <table className="portfolio__table" aria-busy={status === 'loading'}>
        <caption className="portfolio__caption">
          Your manual positions valued against the live mock feed
        </caption>
        <thead>
          <tr>
            <th scope="col">Position</th>
            <th scope="col" className="portfolio__num">
              Quantity
            </th>
            <th scope="col" className="portfolio__num">
              Avg cost
            </th>
            <th scope="col" className="portfolio__num">
              Current price
            </th>
            <th scope="col" className="portfolio__num">
              Total cost
            </th>
            <th scope="col" className="portfolio__num">
              Current value
            </th>
            <th scope="col" className="portfolio__num">
              P/L
            </th>
            <th scope="col">Currency</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {status === 'loading' && (
            <tr>
              <td colSpan={9} role="status" className="portfolio__placeholder">
                Loading portfolio…
              </td>
            </tr>
          )}
          {status === 'empty' && (
            <tr>
              <td colSpan={9} role="status" className="portfolio__placeholder">
                No positions yet.
              </td>
            </tr>
          )}
          {status === 'ready' &&
            portfolio.holdings.map((holding) => {
              const instrument = portfolio.instruments.get(holding.instrumentId)
              if (!instrument) return null
              return (
                <PositionRow
                  key={holding.instrumentId}
                  holding={holding}
                  instrument={instrument}
                  quote={portfolio.quotes.get(holding.instrumentId)}
                  pendingDelete={pendingDelete}
                  onEdit={() => setEditing({ mode: 'edit', holding })}
                  onRequestDelete={() => setPendingDelete(holding.instrumentId)}
                  onConfirmDelete={() => void handleConfirmDelete()}
                  onCancelDelete={() => setPendingDelete(null)}
                />
              )
            })}
        </tbody>
      </table>
    </section>
  )
}

function PositionRow({
  holding,
  instrument,
  quote,
  pendingDelete,
  onEdit,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  holding: Holding
  instrument: Instrument
  quote: Quote | undefined
  pendingDelete: InstrumentId | null
  onEdit: () => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const previousPendingRef = useRef<InstrumentId | null>(null)

  const isPending = pendingDelete === holding.instrumentId

  useEffect(() => {
    if (isPending) {
      confirmRef.current?.focus()
    } else if (previousPendingRef.current === holding.instrumentId) {
      deleteRef.current?.focus()
    }
    previousPendingRef.current = pendingDelete
  }, [isPending, holding.instrumentId, pendingDelete])

  const hasQuote = quote !== undefined
  const currency = instrument.currency
  const cost = costOf(holding)
  const value = hasQuote ? valueOf(holding, quote.price) : null
  const profitLoss = hasQuote ? profitLossOf(holding, quote.price) : null
  const percent = hasQuote ? profitLossPercentOf(holding, quote.price) : null
  const direction =
    profitLoss === null
      ? 'flat'
      : profitLoss > 0
        ? 'up'
        : profitLoss < 0
          ? 'down'
          : 'flat'

  return (
    <tr>
      <th scope="row">
        <span className="portfolio__symbol">{instrument.symbol}</span>
        <span className="portfolio__name">{instrument.displayName}</span>
      </th>
      <td className="portfolio__num">{formatQuantity(holding.quantity)}</td>
      <td className="portfolio__num">
        {formatPrice(holding.averageCost, currency)}
      </td>
      <td className="portfolio__num">
        {hasQuote ? formatPrice(quote.price, currency) : PLACEHOLDER}
      </td>
      <td className="portfolio__num">{formatPrice(cost, currency)}</td>
      <td className="portfolio__num">
        {value === null ? PLACEHOLDER : formatPrice(value, currency)}
      </td>
      <td className="portfolio__num portfolio__pl">
        {profitLoss === null ? (
          PLACEHOLDER
        ) : (
          <span
            data-direction={direction}
            className={`portfolio__pl--${direction}`}
          >
            {`${formatSignedAmount(profitLoss, currency)} (${formatSignedPercent(percent as number)})`}
          </span>
        )}
      </td>
      <td>{currency}</td>
      <td className="portfolio__actions">
        {isPending ? (
          <>
            <span role="alert">Remove {instrument.symbol} position?</span>
            <div className="portfolio__confirm">
              <button
                ref={confirmRef}
                type="button"
                className="portfolio__delete"
                onClick={onConfirmDelete}
              >
                Confirm delete
              </button>
              <button
                type="button"
                className="portfolio__cancel"
                onClick={onCancelDelete}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              className="portfolio__action"
              onClick={onEdit}
            >
              Edit {instrument.symbol} position
            </button>
            <button
              ref={deleteRef}
              type="button"
              className="portfolio__action portfolio__action--danger"
              onClick={onRequestDelete}
            >
              Delete {instrument.symbol} position
            </button>
          </>
        )}
      </td>
    </tr>
  )
}

type HoldingFormProps = {
  instruments: readonly Instrument[]
  heldInstrumentIds: ReadonlySet<InstrumentId>
  initial?: Holding
  onSubmit: (holding: Holding) => Promise<boolean>
  onCancel: () => void
  operationError: string | null
}

function HoldingForm({
  instruments,
  heldInstrumentIds,
  initial,
  onSubmit,
  onCancel,
  operationError,
}: HoldingFormProps) {
  const [instrumentId, setInstrumentId] = useState<InstrumentId>(
    initial?.instrumentId ?? '',
  )
  const [quantity, setQuantity] = useState(
    initial ? String(initial.quantity) : '',
  )
  const [averageCost, setAverageCost] = useState(
    initial ? String(initial.averageCost) : '',
  )
  const [quantityError, setQuantityError] = useState(false)
  const [costError, setCostError] = useState(false)

  const available = initial
    ? []
    : instruments.filter((instrument) => !heldInstrumentIds.has(instrument.id))

  const label = initial
    ? `Edit ${initial.instrumentId} position`
    : 'Add position'

  const isQuantityValid = (value: string) => {
    const parsed = Number(value)
    return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0
  }

  const isCostValid = (value: string) => {
    const parsed = Number(value)
    return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const quantityOk = isQuantityValid(quantity)
    const costOk = isCostValid(averageCost)
    setQuantityError(!quantityOk)
    setCostError(!costOk)
    if (!quantityOk || !costOk) return

    const targetId = initial?.instrumentId ?? instrumentId
    if (!targetId) return

    const ok = await onSubmit({
      instrumentId: targetId,
      quantity: Number(quantity),
      averageCost: Number(averageCost),
    })
    if (!ok) return
  }

  return (
    <form
      className="portfolio__form"
      aria-label={label}
      noValidate
      onSubmit={(event) => void handleSubmit(event)}
    >
      {!initial ? (
        <div className="portfolio__field">
          <label htmlFor="portfolio-instrument">Instrument</label>
          <select
            id="portfolio-instrument"
            value={instrumentId}
            onChange={(event) => setInstrumentId(event.target.value)}
            required
          >
            <option value="" disabled>
              Select an instrument
            </option>
            {available.map((instrument) => (
              <option key={instrument.id} value={instrument.id}>
                {instrument.symbol} — {instrument.displayName}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="portfolio__locked-instrument">
          <strong>{initial.instrumentId}</strong>
        </p>
      )}

      <div className="portfolio__field">
        <label htmlFor="portfolio-quantity">Quantity</label>
        <input
          id="portfolio-quantity"
          type="number"
          min="0.01"
          step="any"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          aria-invalid={quantityError || undefined}
          aria-describedby={
            quantityError ? 'portfolio-quantity-error' : undefined
          }
        />
        {quantityError && (
          <p
            id="portfolio-quantity-error"
            role="alert"
            className="portfolio__field-error"
          >
            Quantity must be greater than zero.
          </p>
        )}
      </div>

      <div className="portfolio__field">
        <label htmlFor="portfolio-average-cost">Average cost</label>
        <input
          id="portfolio-average-cost"
          type="number"
          min="0.01"
          step="any"
          value={averageCost}
          onChange={(event) => setAverageCost(event.target.value)}
          aria-invalid={costError || undefined}
          aria-describedby={
            costError ? 'portfolio-average-cost-error' : undefined
          }
        />
        {costError && (
          <p
            id="portfolio-average-cost-error"
            role="alert"
            className="portfolio__field-error"
          >
            Average cost must be greater than zero.
          </p>
        )}
      </div>

      {operationError && (
        <p role="alert" className="portfolio__field-error">
          {operationError}
        </p>
      )}

      <div className="portfolio__form-actions">
        <button type="submit" className="portfolio__save">
          Save position
        </button>
        <button type="button" className="portfolio__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
