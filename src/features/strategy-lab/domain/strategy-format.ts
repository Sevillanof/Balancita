import { amount } from '../../../shared/finance/format.ts'

const MINUS = '−'

/** `+24,02`, `−13,51`; `null` when the number is absent (the caller shows "No disponible"). */
export function signedAmount(
  value: number | null | undefined,
  digits = 2,
): string | null {
  if (value == null) return null
  const rounded = Number(value.toFixed(digits))
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : ''
  return `${sign}${amount(Math.abs(rounded), digits)}`
}

/** `+174,59 USD`. */
export function netUsd(value: number | null | undefined): string | null {
  const text = signedAmount(value, 2)
  return text === null ? null : `${text} USD`
}

const COUNT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 })

/** Whole numbers with a thousands dot from 1.000 (es-ES would skip it below 10.000). */
export function count(value: number | null | undefined): string {
  return value == null ? '—' : COUNT.format(value)
}

/** `1 h`, `24 h`, `90 min`. */
export function horizonText(minutes: number | null | undefined): string | null {
  if (minutes == null) return null
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}
