/**
 * The values of a VectorBT exploration: a range (minimum, maximum, step) or a
 * list typed by hand, at most 12 (the server refuses more and never widens
 * the list by itself). Decimals are counted as integers so `0.1 + 0.2` never
 * drifts.
 */
export const MAX_VALUES = 12

const NUMBER = /^-?\d+(?:\.\d+)?$/

export type ValueResult = {
  values: string[]
  /** How many values the input asks for (can be above the maximum). */
  count: number
  error: string | null
}

/** `1,5` or `1.5` → `1.5`; null when it is not a number. */
export function toNumberText(text: string): string | null {
  const normalized = text.trim().replace(',', '.')
  if (!NUMBER.test(normalized)) return null
  return shortNumber(normalized)
}

/** `2.50` → `2.5`, `-0` → `0`, `3.0` → `3` (the way the server writes it). */
function shortNumber(text: string): string {
  const [whole = '0', fraction = ''] = text.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  const sign = whole.startsWith('-') ? '-' : ''
  const digits = whole.replace('-', '').replace(/^0+(?=\d)/, '')
  const out = `${sign}${digits}${trimmed ? `.${trimmed}` : ''}`
  return out === '-0' ? '0' : out
}

const decimals = (text: string) => text.split('.')[1]?.length ?? 0

function scaled(text: string, scale: number): bigint {
  const [whole = '0', fraction = ''] = text.split('.')
  const negative = whole.startsWith('-')
  const digits = BigInt(whole.replace('-', '') + fraction.padEnd(scale, '0'))
  return negative ? -digits : digits
}

function unscaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale)
  return shortNumber(
    `${negative ? '-' : ''}${whole}${scale ? `.${fraction}` : ''}`,
  )
}

const tooMany = (count: number, advice: string) =>
  `Salen ${count} valores y el máximo es ${MAX_VALUES}. ${advice}`

/** Values from `min` to `max` (included) every `step`. */
export function rangeValues(
  min: string,
  max: string,
  step: string,
): ValueResult {
  const a = toNumberText(min)
  const b = toNumberText(max)
  const s = toNumberText(step)
  const fail = (error: string): ValueResult => ({
    values: [],
    count: 0,
    error,
  })
  if (a === null || b === null || s === null)
    return fail('Escribí el mínimo, el máximo y el paso como números.')
  const scale = Math.max(decimals(a), decimals(b), decimals(s))
  const lo = scaled(a, scale)
  const hi = scaled(b, scale)
  const by = scaled(s, scale)
  if (by <= 0n) return fail('El paso tiene que ser mayor que cero.')
  if (hi < lo) return fail('El máximo no puede ser menor que el mínimo.')
  const count = Number((hi - lo) / by) + 1
  if (count > MAX_VALUES)
    return {
      values: [],
      count,
      error: tooMany(count, 'Achicá el rango o agrandá el paso.'),
    }
  const values: string[] = []
  for (let value = lo; value <= hi; value += by)
    values.push(unscaled(value, scale))
  return { values, count, error: null }
}

/** Values typed by hand, separated by `;`, spaces or new lines (a comma is a decimal comma). */
export function listValues(text: string): ValueResult {
  const parts = text.split(/[;\s]+/).filter((part) => part !== '')
  if (parts.length === 0)
    return {
      values: [],
      count: 0,
      error: 'Escribí al menos un valor, separados por punto y coma.',
    }
  const values: string[] = []
  for (const part of parts) {
    const value = toNumberText(part)
    if (value === null)
      return { values: [], count: 0, error: `«${part}» no es un número.` }
    if (!values.includes(value)) values.push(value)
  }
  if (values.length > MAX_VALUES)
    return {
      values: [],
      count: values.length,
      error: tooMany(values.length, 'Sacá algunos de la lista.'),
    }
  return { values, count: values.length, error: null }
}
