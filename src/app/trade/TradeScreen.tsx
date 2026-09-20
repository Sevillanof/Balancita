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
      <section className="trade" aria-label="Operar">
        <h2 className="trade__title">Operar</h2>
        <p role="status" className="trade__empty">
          No hay instrumentos disponibles para operar en el simulador.
        </p>
      </section>
    )
  }

  return (
    <section className="trade" aria-label="Operar">
      <div className="trade__header">
        <h2 className="trade__title">Operar</h2>
        {cash && selectedCurrency && (
          <p className="trade__cash-inline">
            Efectivo ({selectedCurrency}):{' '}
            {formatPriceMoney(cash, asCurrency(selectedCurrency))}
          </p>
        )}
      </div>

      <form
        className="trade__form"
        aria-label="Orden del simulador"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void handlePreview()
        }}
      >
        <div className="trade__field">
          <label htmlFor="trade-instrument">Instrumento</label>
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
            Precio en vivo:{' '}
            {price === null
              ? '—'
              : formatPrice(
                  price,
                  asCurrency(trading.selectedInstrument?.currency ?? 'EUR'),
                )}
          </p>
        </div>

        <div className="trade__field">
          <span className="trade__label">Tipo de operación</span>
          <div
            role="group"
            aria-label="Tipo de operación"
            className="trade__side"
          >
            <button
              type="button"
              aria-pressed={trading.side === BUY}
              className={`trade__side-btn ${trading.side === BUY ? 'trade__side-btn--active' : ''}`}
              onClick={() => trading.setSide(BUY)}
            >
              Comprar
            </button>
            <button
              type="button"
              aria-pressed={trading.side === SELL}
              className={`trade__side-btn ${trading.side === SELL ? 'trade__side-btn--active' : ''}`}
              onClick={() => trading.setSide(SELL)}
            >
              Vender
            </button>
          </div>
        </div>

        <div className="trade__field">
          <label htmlFor="trade-quantity">Cantidad</label>
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
              La cantidad debe ser un número decimal positivo.
            </p>
          )}
        </div>

        <div className="trade__field">
          <label htmlFor="trade-cash">Efectivo disponible</label>
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
            <span>{formatTradingMessage(trading.previewError)}</span>{' '}
            <button
              type="button"
              className="trade__retry"
              onClick={trading.resetTrade}
            >
              Nueva vista previa
            </button>
          </p>
        )}

        <div className="trade__actions">
          <button
            type="submit"
            className="trade__primary"
            disabled={!canPreview || trading.previewing}
          >
            {trading.previewing
              ? 'Solicitando vista previa…'
              : 'Vista previa de la orden'}
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
          <span>{formatTradingMessage(trading.submitError)}</span>{' '}
          <button
            type="button"
            className="trade__retry"
            onClick={handleNewOrder}
          >
            Nueva orden
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
        <section className="trade__history" aria-label="Historial de órdenes">
          <h3 className="trade__history-title">Historial de órdenes</h3>
          <ul className="trade__history-list">
            {[...trading.account.history]
              .reverse()
              .slice(0, 10)
              .map((receipt) => (
                <li key={receipt.id} className="trade__history-item">
                  <span className="trade__history-id">{receipt.id}</span>
                  <span className={`trade__history-status--${receipt.status}`}>
                    {formatOrderStatus(receipt.status)}
                  </span>
                  <span>{formatOrderSide(receipt.side)}</span>
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
                  {receipt.reason && (
                    <em>({formatOrderReason(receipt.reason)})</em>
                  )}
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
    <section className="trade__summary" aria-label="Vista previa de la orden">
      <h3 className="trade__summary-title">Vista previa</h3>
      <dl className="trade__summary-grid">
        <dt>Tipo de operación</dt>
        <dd>{formatOrderSide(side)}</dd>
        <dt>Cantidad</dt>
        <dd>{formatQuantity(quantity)}</dd>
        <dt>Precio de mercado</dt>
        <dd>{formatPriceMoney(price, currency)}</dd>
        <dt>Ejecución estimada</dt>
        <dd>{formatPriceMoney(slippedPrice, currency)}</dd>
        <dt>Deslizamiento</dt>
        <dd>
          {isMoneyZero(slippageApplied)
            ? 'ninguno'
            : formatSignedPercent(slippageApplied)}
        </dd>
        <dt>Comisión</dt>
        <dd>
          {isMoneyZero(commission)
            ? 'ninguna'
            : formatPriceMoney(commission, currency)}
        </dd>
        <dt>Subtotal</dt>
        <dd>{formatPriceMoney(subtotal, currency)}</dd>
        <dt className="trade__summary-total">Total estimado</dt>
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
        {confirming ? 'Confirmando…' : 'Confirmar orden'}
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
    <section className="trade__receipt" aria-label="Resultado de la orden">
      <h3 className="trade__receipt-title">
        {executed ? 'Orden ejecutada' : 'Orden rechazada'}
      </h3>
      {receipt.reason && (
        <p className="trade__receipt-reason">
          Motivo: {formatOrderReason(receipt.reason)}
        </p>
      )}
      <dl className="trade__summary-grid">
        <dt>Comprobante</dt>
        <dd>{receipt.id}</dd>
        <dt>Tipo de operación</dt>
        <dd>{formatOrderSide(receipt.side)}</dd>
        <dt>Cantidad</dt>
        <dd>{formatQuantity(receipt.quantity)}</dd>
        <dt>Precio ejecutado</dt>
        <dd>{formatPriceMoney(receipt.executedPrice, currency)}</dd>
        {receipt.slippedPrice !== undefined && (
          <>
            <dt>Ejecución efectiva</dt>
            <dd>{formatPriceMoney(receipt.slippedPrice, currency)}</dd>
          </>
        )}
        <dt>Total</dt>
        <dd>{formatPriceMoney(receipt.total, currency)}</dd>
        <dt>Hora</dt>
        <dd>{formatLocalTime(receipt.executedAt)}</dd>
      </dl>
      <button type="button" className="trade__secondary" onClick={onNewOrder}>
        Operar nuevamente
      </button>
    </section>
  )
}

function formatOrderSide(side: OrderSide): string {
  return side === BUY ? 'Comprar' : 'Vender'
}

function formatOrderStatus(status: OrderReceipt['status']): string {
  return status === 'executed' ? 'Ejecutada' : 'Rechazada'
}

function formatOrderReason(reason: string): string {
  const labels: Record<string, string> = {
    'insufficient-cash': 'Fondos insuficientes',
    'insufficient-position': 'Posición insuficiente',
    'preview-outdated': 'La cotización cambió; solicite una nueva vista previa',
  }
  return labels[reason] ?? 'La operación no pudo completarse.'
}

function formatTradingMessage(message: string | null): string {
  if (message === null) return ''
  return formatOrderReason(message)
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
