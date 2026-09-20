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

export function formatQuantity(quantity: number): string {
  return quantity.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

export function formatSignedAmount(
  value: number,
  currency: InstrumentCurrency,
): string {
  if (value === 0) return formatPrice(0, currency)
  const sign = value > 0 ? '+' : '-'
  return `${sign}${formatPrice(Math.abs(value), currency)}`
}

export function formatSignedPercent(value: number): string {
  if (value === 0) return '0.00%'
  const sign = value > 0 ? '+' : '-'
  return `${sign}${formatDecimal(Math.abs(value))}%`
}
