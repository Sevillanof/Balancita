import { useState } from 'react'
import type {
  InstrumentCurrency,
  MarketDataProvider,
} from '../../domain/market-data'
import {
  moneyFromString,
  moneyIsPositive,
  moneyIsZero,
  type Money,
} from '../../domain/money'
import {
  BUY,
  SELL,
  type OrderReceipt,
  type OrderSide,
} from '../../domain/orders'
import {
  formatPrice,
  formatPriceMoney,
  formatQuantity,
  formatSignedPercent,
} from '../format'
import { useTrading } from './useTrading'
import './trade.css'

type TradeScreenProps = {
  provider: MarketDataProvider
}

function asCurrency(value: string): InstrumentCurrency {
  return value === 'USD' ? 'USD' : 'EUR'
}

export default function TradeScreen({ provider }: TradeScreenProps) {
  const trading = useTrading(provider)
  const [quantity, setQuantity] = useState('')
  const quantityOk = isPositiveMoneyInput(quantity)
  const selectedCurrency = trading.selectedInstrument?.currency
  const cash =
    selectedCurrency === undefined
      ? undefined
      : trading.account?.cash[selectedCurrency]
  const price = trading.selectedInstrumentId
    ? trading.priceOf(trading.selectedInstrumentId)
    : null

  const canPreview =
    trading.selectedInstrumentId !== null && quantityOk && price !== null

  const handlePreview = async () => {
    if (!canPreview) return
    await trading.requestPreview(moneyFromString(quantity))
  }

  const handleConfirm = async () => {
    await trading.confirmOrder()
  }

  const handleNewOrder = () => {
    trading.resetTrade()
    setQuantity('')
  }

  if (trading.selectedInstrumentId === null) {
    return (
      <section className="trade" aria-label="Trade">
        <h2 className="trade__title">Trade</h2>
        <p role="status" className="trade__empty">
          No instruments available for paper trading.
        </p>
      </section>
    )
  }

  return (
    <section className="trade" aria-label="Trade">
      <div className="trade__header">
        <h2 className="trade__title">Trade</h2>
        {cash && selectedCurrency && (
          <p className="trade__cash-inline">
            Cash ({selectedCurrency}):{' '}
            {formatPriceMoney(cash, asCurrency(selectedCurrency))}
          </p>
        )}
      </div>

      <form
        className="trade__form"
        aria-label="Paper trading order"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void handlePreview()
        }}
      >
        <div className="trade__field">
          <label htmlFor="trade-instrument">Instrument</label>
          <select
            id="trade-instrument"
            value={trading.selectedInstrumentId}
            onChange={(event) => trading.selectInstrument(event.target.value)}
          >
            {trading.instruments.map((instrument) => (
              <option key={instrument.id} value={instrument.id}>
                {instrument.symbol} — {instrument.displayName} (
                {instrument.currency})
              </option>
            ))}
          </select>
          <p className="trade__price">
            Live price:{' '}
            {price === null
              ? '—'
              : formatPrice(
                  price,
                  asCurrency(trading.selectedInstrument?.currency ?? 'EUR'),
                )}
          </p>
        </div>

        <div className="trade__field">
          <span className="trade__label">Side</span>
          <div role="group" aria-label="Order side" className="trade__side">
            <button
              type="button"
              aria-pressed={trading.side === BUY}
              className={`trade__side-btn ${trading.side === BUY ? 'trade__side-btn--active' : ''}`}
              onClick={() => trading.setSide(BUY)}
            >
              Buy
            </button>
            <button
              type="button"
              aria-pressed={trading.side === SELL}
              className={`trade__side-btn ${trading.side === SELL ? 'trade__side-btn--active' : ''}`}
              onClick={() => trading.setSide(SELL)}
            >
              Sell
            </button>
          </div>
        </div>

        <div className="trade__field">
          <label htmlFor="trade-quantity">Quantity</label>
          <input
            id="trade-quantity"
            type="number"
            min="0.01"
            step="any"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            aria-invalid={(quantity !== '' && !quantityOk) || undefined}
            aria-describedby={!quantityOk ? 'trade-quantity-error' : undefined}
          />
          {quantity !== '' && !quantityOk && (
            <p
              id="trade-quantity-error"
              role="alert"
              className="trade__field-error"
            >
              Quantity must be a positive decimal number.
            </p>
          )}
        </div>

        <div className="trade__field">
          <label htmlFor="trade-cash">Available cash</label>
          <p id="trade-cash" className="trade__cash">
            {cash === undefined
              ? '—'
              : formatPriceMoney(
                  cash,
                  asCurrency(trading.selectedInstrument?.currency ?? 'EUR'),
                )}
          </p>
        </div>

        {trading.previewError && (
          <p role="alert" className="trade__field-error">
            <span>{trading.previewError}</span>{' '}
            <button
              type="button"
              className="trade__retry"
              onClick={trading.resetTrade}
            >
              New preview
            </button>
          </p>
        )}

        <div className="trade__actions">
          <button
            type="submit"
            className="trade__primary"
            disabled={!canPreview || trading.previewing}
          >
            {trading.previewing ? 'Requesting preview…' : 'Preview order'}
          </button>
        </div>
      </form>

      {trading.preview && (
        <OrderSummary
          side={trading.preview.side}
          currency={asCurrency(trading.preview.currency)}
          quantity={trading.preview.quantity}
          price={trading.preview.marketPrice}
          slippedPrice={trading.preview.slippedPrice}
          slippageApplied={trading.preview.slippageApplied}
          commission={trading.preview.commission}
          subtotal={trading.preview.subtotal}
          total={trading.preview.estimatedTotal}
          confirming={trading.confirming}
          onConfirm={() => void handleConfirm()}
        />
      )}

      {trading.submitError && (
        <p role="alert" className="trade__field-error">
          <span>{trading.submitError}</span>{' '}
          <button
            type="button"
            className="trade__retry"
            onClick={handleNewOrder}
          >
            New order
          </button>
        </p>
      )}

      {trading.receipt && (
        <Receipt
          receipt={trading.receipt}
          currency={asCurrency(trading.selectedInstrument?.currency ?? 'EUR')}
          onNewOrder={handleNewOrder}
        />
      )}

      {trading.account && trading.account.history.length > 0 && (
        <section className="trade__history" aria-label="Order history">
          <h3 className="trade__history-title">Order history</h3>
          <ul className="trade__history-list">
            {[...trading.account.history]
              .reverse()
              .slice(0, 10)
              .map((receipt) => (
                <li key={receipt.id} className="trade__history-item">
                  <span className="trade__history-id">{receipt.id}</span>
                  <span className={`trade__history-status--${receipt.status}`}>
                    {receipt.status}
                  </span>
                  <span>{receipt.side}</span>
                  <span>{receipt.instrumentId}</span>
                  <span>
                    {formatQuantity(receipt.quantity)} @{' '}
                    {formatPriceMoney(
                      receipt.executedPrice,
                      asCurrency(trading.selectedInstrument?.currency ?? 'EUR'),
                    )}
                  </span>
                  <span>
                    {formatPriceMoney(
                      receipt.total,
                      asCurrency(trading.selectedInstrument?.currency ?? 'EUR'),
                    )}
                  </span>
                  {receipt.reason && <em>({receipt.reason})</em>}
                </li>
              ))}
          </ul>
        </section>
      )}
    </section>
  )
}

function isMoneyZero(value: Money): boolean {
  return moneyIsZero(value)
}

function OrderSummary({
  side,
  currency,
  quantity,
  price,
  slippedPrice,
  slippageApplied,
  commission,
  subtotal,
  total,
  confirming,
  onConfirm,
}: {
  side: OrderSide
  currency: InstrumentCurrency
  quantity: Money
  price: Money
  slippedPrice: Money
  slippageApplied: Money
  commission: Money
  subtotal: Money
  total: Money
  confirming: boolean
  onConfirm: () => void
}) {
  return (
    <section className="trade__summary" aria-label="Order preview">
      <h3 className="trade__summary-title">Preview</h3>
      <dl className="trade__summary-grid">
        <dt>Side</dt>
        <dd>{side}</dd>
        <dt>Quantity</dt>
        <dd>{formatQuantity(quantity)}</dd>
        <dt>Market price</dt>
        <dd>{formatPriceMoney(price, currency)}</dd>
        <dt>Estimated fill</dt>
        <dd>{formatPriceMoney(slippedPrice, currency)}</dd>
        <dt>Slippage</dt>
        <dd>
          {isMoneyZero(slippageApplied)
            ? 'none'
            : formatSignedPercent(slippageApplied)}
        </dd>
        <dt>Commission</dt>
        <dd>
          {isMoneyZero(commission)
            ? 'none'
            : formatPriceMoney(commission, currency)}
        </dd>
        <dt>Subtotal</dt>
        <dd>{formatPriceMoney(subtotal, currency)}</dd>
        <dt className="trade__summary-total">Estimated total</dt>
        <dd className="trade__summary-total">
          {formatPriceMoney(total, currency)}
        </dd>
      </dl>
      <button
        type="button"
        className="trade__primary"
        disabled={confirming}
        onClick={onConfirm}
      >
        {confirming ? 'Confirming…' : 'Confirm order'}
      </button>
    </section>
  )
}

function Receipt({
  receipt,
  currency,
  onNewOrder,
}: {
  receipt: OrderReceipt
  currency: InstrumentCurrency
  onNewOrder: () => void
}) {
  const executed = receipt.status === 'executed'
  return (
    <section className="trade__receipt" aria-label="Order result">
      <h3 className="trade__receipt-title">
        {executed ? 'Order executed' : 'Order rejected'}
      </h3>
      {receipt.reason && (
        <p className="trade__receipt-reason">Reason: {receipt.reason}</p>
      )}
      <dl className="trade__summary-grid">
        <dt>Receipt</dt>
        <dd>{receipt.id}</dd>
        <dt>Side</dt>
        <dd>{receipt.side}</dd>
        <dt>Quantity</dt>
        <dd>{formatQuantity(receipt.quantity)}</dd>
        <dt>Executed price</dt>
        <dd>{formatPriceMoney(receipt.executedPrice, currency)}</dd>
        {receipt.slippedPrice !== undefined && (
          <>
            <dt>Effective fill</dt>
            <dd>{formatPriceMoney(receipt.slippedPrice, currency)}</dd>
          </>
        )}
        <dt>Total</dt>
        <dd>{formatPriceMoney(receipt.total, currency)}</dd>
        <dt>Time</dt>
        <dd>{formatLocalTime(receipt.executedAt)}</dd>
      </dl>
      <button type="button" className="trade__secondary" onClick={onNewOrder}>
        Trade again
      </button>
    </section>
  )
}

function formatLocalTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function isPositiveMoneyInput(value: string): boolean {
  if (value === '') return false
  try {
    return moneyIsPositive(moneyFromString(value))
  } catch {
    return false
  }
}
