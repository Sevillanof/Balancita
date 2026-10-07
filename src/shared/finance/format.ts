const number = (digits: number) =>
  new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })

const MINUS = '−'

/** `+2,6 %`, `−1,1 %`, `0,0 %`. */
export function signedPercent(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits))
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : ''
  return `${sign}${number(digits).format(Math.abs(rounded))} %`
}

/** `+262,40 US$`. */
export function signedUsd(value: number): string {
  const rounded = Number(value.toFixed(2))
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : ''
  return `${sign}${number(2).format(Math.abs(rounded))} US$`
}

export function price(value: number): string {
  return number(2).format(value)
}

export function percent(value: number, digits = 0): string {
  return `${number(digits).format(value)} %`
}

export function utcTime(seconds: number): string {
  return new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(seconds * 1000))
}

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
