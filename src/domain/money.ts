/**
 * Fixed-point decimal money with explicit arithmetic - no floating point.
 *
 * WHY THIS MECHANISM (decision): an internal fixed-scale wrapper over native
 * `bigint` instead of a decimal library such as decimal.js. Balancita is
 * local-first and deliberately dependency-minimal, and order/valuation math
 * only needs a handful of exact operations at a fixed scale. `bigint` is exact
 * across the whole range, never reintroduces float error, and keeps rounding
 * and serialization under our control. It can be swapped for a full decimal
 * library behind `Money` later without touching call sites.
 *
 * Scale: every amount is an integer number of units of 1e-8 of the base
 * currency (8 decimal places). Multiplication and division round half away
 * from zero at that scale; `moneyRound` rounds to cash (2 dp).
 *
 * Serialization: storage always uses the canonical decimal string produced by
 * `moneyToDecimalString`. The wrapper object must never be written via
 * `JSON.stringify` directly (bigint is not serializable).
 *
 * `moneyToNumber` exists ONLY for display formatting. It must never feed a
 * monetary calculation back into the engine.
 */
export const MONEY_SCALE = 8

const SCALE = 10n ** BigInt(MONEY_SCALE)
const CASH_ROUND_UNITS = SCALE / 100n

export type Money = {
  /** Amount expressed in integer units of 1e-8 of the base currency. */
  units: bigint
}

export const MONEY_ZERO: Money = { units: 0n }

/** Raised when a decimal string cannot be parsed into a valid Money value. */
export class MoneyParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MoneyParseError'
  }
}

/** Raised when a monetary division would divide by zero. */
export class MoneyDivideByZeroError extends Error {
  constructor() {
    super('Monetary division by zero.')
    this.name = 'MoneyDivideByZeroError'
  }
}

function bigAbs(value: bigint): bigint {
  return value < 0n ? -value : value
}

/** Integer division rounded half away from zero. */
function roundDiv(dividend: bigint, divisor: bigint): bigint {
  if (divisor === 0n) throw new MoneyDivideByZeroError()
  const sign = dividend < 0n === divisor < 0n ? 1n : -1n
  return sign * ((bigAbs(dividend) + bigAbs(divisor) / 2n) / bigAbs(divisor))
}

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

function signature(value: string): {
  sign: 'positive' | 'negative'
  units: bigint
  hasOverflow: boolean
} {
  const match = DECIMAL_RE.exec(value)
  if (match === null) {
    throw new MoneyParseError(
      `Invalid decimal value: ${JSON.stringify(value)}.`,
    )
  }
  const [, sign, integerPart, fractionPartRaw, exponentRaw] = match
  const fractionPart = fractionPartRaw ?? ''
  const digits = `${integerPart}${fractionPart}`
  const exponent = exponentRaw === undefined ? 0n : BigInt(exponentRaw)
  if (exponent > 100n || exponent < -100n) {
    throw new MoneyParseError(
      `Decimal exponent out of range: ${JSON.stringify(value)}.`,
    )
  }

  let overflow = 0n
  let scaleAdjust = BigInt(MONEY_SCALE) - BigInt(fractionPart.length) + exponent
  if (scaleAdjust < 0n) {
    overflow = -scaleAdjust
    scaleAdjust = 0n
  }

  const unit = BigInt(digits) * 10n ** scaleAdjust
  return {
    sign: sign === '-' ? 'negative' : 'positive',
    units: overflow > 0n ? roundDiv(unit, 10n ** overflow) : unit,
    hasOverflow: overflow > 0n,
  }
}

/** Builds a Money from a raw integer number of scale-8 units. */
export function money(units: bigint): Money {
  return { units }
}

/**
 * Parses an authored decimal string strictly. Rejects malformed input and
 * values with more than 8 fraction digits (they would lose precision).
 */
export function moneyFromString(value: string): Money {
  const parsed = signature(value)
  if (parsed.hasOverflow) {
    throw new MoneyParseError(
      `Decimal value has more than ${MONEY_SCALE} fraction digits: ${JSON.stringify(
        value,
      )}.`,
    )
  }
  return money(parsed.sign === 'negative' ? -parsed.units : parsed.units)
}

/**
 * Converts a finite number into Money at the price/data frontier. The number's
 * decimal representation is parsed and any excess fraction digits are ROUNDED
 * to scale 8, so float artifacts such as 0.1 + 0.2 never leak into arithmetic.
 */
export function moneyFromNumber(value: number): Money {
  if (!Number.isFinite(value)) {
    throw new MoneyParseError(`Non-finite boundary number: ${String(value)}.`)
  }
  try {
    const parsed = signature(value.toString())
    return money(parsed.sign === 'negative' ? -parsed.units : parsed.units)
  } catch (cause) {
    throw new MoneyParseError(
      `Could not convert number to Money: ${String(value)}.`,
      cause,
    )
  }
}

/** Display-only conversion; must never feed back into monetary math. */
export function moneyToNumber(value: Money): number {
  return Number(value.units) / Number(SCALE)
}

/** Canonical decimal-string form used for storage and auditing. */
export function moneyToDecimalString(value: Money): string {
  const negative = value.units < 0n
  const absolute = bigAbs(value.units)
  const integer = absolute / SCALE
  const fraction = absolute % SCALE
  if (fraction === 0n) return `${negative ? '-' : ''}${integer.toString()}`
  let fractionText = fraction.toString().padStart(MONEY_SCALE, '0')
  fractionText = fractionText.replace(/0+$/, '')
  return `${negative ? '-' : ''}${integer.toString()}.${fractionText}`
}

export function moneyAdd(a: Money, b: Money): Money {
  return money(a.units + b.units)
}

export function moneySub(a: Money, b: Money): Money {
  return money(a.units - b.units)
}

export function moneyMul(a: Money, b: Money): Money {
  return money(roundDiv(a.units * b.units, SCALE))
}

export function moneyDiv(a: Money, b: Money): Money {
  return money(roundDiv(a.units * SCALE, b.units))
}

/** Rounds an amount to cash precision (2 decimal places), half away from zero. */
export function moneyRound(value: Money): Money {
  const cents = roundDiv(value.units, CASH_ROUND_UNITS)
  return money(cents * CASH_ROUND_UNITS)
}

export function moneyAbs(value: Money): Money {
  return money(bigAbs(value.units))
}

export function moneyNegate(value: Money): Money {
  return money(-value.units)
}

export function moneyCompare(a: Money, b: Money): number {
  if (a.units === b.units) return 0
  return a.units < b.units ? -1 : 1
}

export function moneyIsZero(value: Money): boolean {
  return value.units === 0n
}

export function moneyIsPositive(value: Money): boolean {
  return value.units > 0n
}

export function moneyIsNegative(value: Money): boolean {
  return value.units < 0n
}

export function moneyEq(a: Money, b: Money): boolean {
  return a.units === b.units
}

export function moneyGt(a: Money, b: Money): boolean {
  return a.units > b.units
}

export function moneyGte(a: Money, b: Money): boolean {
  return a.units >= b.units
}

export function moneyLt(a: Money, b: Money): boolean {
  return a.units < b.units
}

export function moneyLte(a: Money, b: Money): boolean {
  return a.units <= b.units
}

/** Loose shape guard used by persistence validators. */
export function isMoney(value: unknown): value is Money {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { units: unknown }).units === 'bigint'
  )
}
