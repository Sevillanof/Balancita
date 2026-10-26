const number = (digits: number) =>
  new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })

/** `1.234,50 US$` for a number; `—` when absent. */
export function usd(value: number | null | undefined, digits = 2): string {
  return value == null
    ? '—'
    : new Intl.NumberFormat('es-ES', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value)
}

/** Same as `usd` for any ISO currency (chart axes follow the instrument). */
export function currency(value: number, code: string, digits = 2): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

/** Plain es-ES number with fixed decimals; `—` when absent. */
export function amount(value: number | null | undefined, digits = 2): string {
  return value == null ? '—' : number(digits).format(value)
}

/** `1,2 mil US$`-style compact USD; `—` when absent. */
export function compactUsd(value: number | null | undefined): string {
  return value == null
    ? '—'
    : new Intl.NumberFormat('es-ES', {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value)
}

/** Decimal strings from the wire ("100150.5") as USD; null when not a number. */
export function usdFromString(value: unknown, digits = 2): string | null {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return null
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
  }).format(Number(value))
}

/** `7/10/2026, 12:39:00 UTC` from epoch milliseconds. */
export function utcDateTime(ms: number): string {
  return `${new Date(ms).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`
}
