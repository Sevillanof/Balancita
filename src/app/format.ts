import { moneyToNumber, type Money } from '../domain/money'
import type { Quote } from '../domain/market-data'

export type InstrumentCurrency = 'EUR' | 'USD'

const CURRENCY_SYMBOLS: Record<InstrumentCurrency, string> = {
  EUR: '€',
  USD: '$',
}

function formatDecimal(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatPrice(
  price: number,
  currency: InstrumentCurrency,
): string {
  return `${CURRENCY_SYMBOLS[currency]}${formatDecimal(price)}`
}

/** Formats a fixed-point Money for display; never feeds money math back. */
export function formatPriceMoney(
  amount: Money,
  currency: InstrumentCurrency,
): string {
  return formatPrice(moneyToNumber(amount), currency)
}

export type ChangeDirection = 'up' | 'down' | 'flat'

export function formatChange(quote: Quote): {
  text: string
  direction: ChangeDirection
} {
  const direction: ChangeDirection =
    quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'flat'
  const sign = quote.change > 0 ? '+' : quote.change < 0 ? '-' : ''
  return {
    direction,
    text: `${sign}${formatDecimal(Math.abs(quote.change))} (${sign}${formatDecimal(Math.abs(quote.changePercent))}%)`,
  }
}

export function formatLocalTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function formatQuoteStatus(status: Quote['status']): string {
  switch (status) {
    case 'live':
      return 'En vivo'
    case 'stale':
      return 'Desactualizada'
    case 'mock':
      return 'Simulada'
    default:
      return status
  }
}

export function formatQuantity(quantity: Money): string {
  return moneyToNumber(quantity).toLocaleString('en-US', {
    maximumFractionDigits: 6,
  })
}

export function formatSignedAmount(
  value: Money,
  currency: InstrumentCurrency,
): string {
  const numberValue = moneyToNumber(value)
  if (numberValue === 0) return formatPrice(0, currency)
  const sign = numberValue > 0 ? '+' : '-'
  return `${sign}${formatPrice(Math.abs(numberValue), currency)}`
}

export function formatSignedPercent(value: Money): string {
  const numberValue = moneyToNumber(value)
  if (numberValue === 0) return '0.00%'
  const sign = numberValue > 0 ? '+' : '-'
  return `${sign}${formatDecimal(Math.abs(numberValue))}%`
}
