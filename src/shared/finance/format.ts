// Intl formatters are expensive to build; the chart axis alone formats on every frame.
const formatters = new Map<string, Intl.NumberFormat>()

function formatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options)
  let cached = formatters.get(key)
  if (!cached) {
    cached = new Intl.NumberFormat('es-ES', options)
    formatters.set(key, cached)
  }
  return cached
}

const money = (code: string, digits: number) =>
  formatter({
    style: 'currency',
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })

const number = (digits: number) =>
  formatter({ minimumFractionDigits: digits, maximumFractionDigits: digits })

const utcDate = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})

const madridDate = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const madridClock = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const madridFull = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const madridDay = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

/** `1.234,50 US$` for a number; `—` when absent. */
export function usd(value: number | null | undefined, digits = 2): string {
  return value == null ? '—' : money('USD', digits).format(value)
}

/** Same as `usd` for any ISO currency (chart axes follow the instrument). */
export function currency(value: number, code: string, digits = 2): string {
  return money(code, digits).format(value)
}

/** Plain es-ES number with fixed decimals; `—` when absent. */
export function amount(value: number | null | undefined, digits = 2): string {
  return value == null ? '—' : number(digits).format(value)
}

/** `1,2 mil US$`-style compact USD; `—` when absent. */
export function compactUsd(value: number | null | undefined): string {
  return value == null
    ? '—'
    : formatter({
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value)
}

/** Decimal strings from the wire ("100150.5") as USD; null when not a number. */
export function usdFromString(value: unknown, digits = 2): string | null {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return null
  return formatter({
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
  }).format(Number(value))
}

/** `7/10/2026, 12:39:00 UTC` from epoch milliseconds. */
export function utcDateTime(ms: number): string {
  return `${utcDate.format(ms)} UTC`
}

/** `2 nov, 14:05` in Europe/Madrid (CET/CEST) from epoch milliseconds. */
export function madridDateTime(ms: number): string {
  return madridDate.format(ms)
}

/** `14:05` in Europe/Madrid (CET/CEST, 24 h clock) from epoch milliseconds. */
export function madridTime(ms: number): string {
  return madridClock.format(ms)
}

/** `14:05` when `ms` falls on the same Madrid day as `nowMs`, otherwise `2 nov, 14:05`. */
export function madridDayTime(ms: number, nowMs: number): string {
  return madridDay.format(ms) === madridDay.format(nowMs)
    ? madridTime(ms)
    : madridDateTime(ms)
}

/** `9/11/2026, 23:15:02` in Europe/Madrid, to the second (receipts and records). */
export function madridDateTimeSeconds(ms: number): string {
  return madridFull.format(ms)
}
