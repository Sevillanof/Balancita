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
