/**
 * Exact decimal-string arithmetic for the terminal's money fields. Values are
 * plain decimal text (`-12.5`); no binary floats are involved.
 */

const DECIMAL = /^-?\d+(?:\.\d+)?$/

interface Fixed {
  readonly units: bigint
  readonly scale: number
}

function parse(value: unknown): Fixed | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.')
  const units = BigInt(whole + fraction)
  return { units: negative ? -units : units, scale: fraction.length }
}

function align(left: Fixed, right: Fixed): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale)
  return [
    left.units * 10n ** BigInt(scale - left.scale),
    right.units * 10n ** BigInt(scale - right.scale),
    scale,
  ]
}

function format(units: bigint, scale: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '')
  const text = fraction ? `${whole}.${fraction}` : whole
  return negative && text !== '0' ? `-${text}` : text
}

export function isDecimal(value: unknown): value is string {
  return parse(value) !== null
}

/** `left + right`, or null when either is not a decimal string. */
export function addDecimal(left: unknown, right: unknown): string | null {
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return null
  const [x, y, scale] = align(a, b)
  return format(x + y, scale)
}

/**
 * Unrealized PnL of a linear position: `qty * (mark - entry)`, negated for a
 * short. Null when any input is not a decimal string.
 */
export function unrealizedPnl(
  side: unknown,
  quantity: unknown,
  entry: unknown,
  mark: unknown,
): string | null {
  const qty = parse(quantity)
  const open = parse(entry)
  const now = parse(mark)
  if (!qty || !open || !now || (side !== 'long' && side !== 'short'))
    return null
  const [markUnits, entryUnits, scale] = align(now, open)
  const move = (markUnits - entryUnits) * (side === 'long' ? 1n : -1n)
  return format(move * qty.units, scale + qty.scale)
}
