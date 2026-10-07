import {
  cloneSpec,
  formatDecimal,
  parseDecimalInput,
  type StrategySpec,
} from './strategy-spec.ts'

/** At most this many variants per parameter, so a grid stays readable. */
export const MAX_VARIANTS = 6

/**
 * `"35; 40; 45"` or `"1,5"` → dot decimals, deduplicated, in input order.
 * Returns null when any value is not a number or the list is empty.
 */
export function parseParamValues(input: string): string[] | null {
  const parts = input
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0 || parts.length > MAX_VARIANTS) return null
  const values: string[] = []
  for (const part of parts) {
    const value = parseDecimalInput(part)
    if (value === null) return null
    if (!values.includes(value)) values.push(value)
  }
  return values
}

export type Variant = { label: string; spec: StrategySpec }

/**
 * One spec per value of the swept parameter, each labelled by the value it
 * tries. A single value yields the spec itself with no label.
 */
export function expandVariants(
  spec: StrategySpec,
  param: string,
  values: readonly string[],
): Variant[] {
  if (values.length <= 1) {
    const next = cloneSpec(spec)
    if (values[0] !== undefined) next.params[param] = values[0]
    return [{ label: '', spec: next }]
  }
  return values.map((value) => {
    const next = cloneSpec(spec)
    next.params[param] = value
    return { label: `${param} ${formatDecimal(value)}`, spec: next }
  })
}
