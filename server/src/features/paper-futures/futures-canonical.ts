import { createHash } from 'node:crypto'

export function normalizeDecimal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  )
    throw new TypeError('Decimal values must be finite decimal strings.')
  const [mantissa, exponentText] = value.toLowerCase().split('e')
  const exponent = Number(exponentText ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000)
    throw new RangeError(
      'Decimal exponent is outside the supported canonical range.',
    )
  if (/^[+-]?0*(?:\.0*)?(?:e[+-]?\d+)?$/i.test(value)) return '0'
  const sign = mantissa.startsWith('-') ? '-' : ''
  const unsigned = mantissa.replace(/^[+-]/, '')
  const [whole = '', fraction = ''] = unsigned.split('.')
  const digits = `${whole}${fraction}`
  const point = whole.length + exponent
  let plain =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${'0'.repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`
  if (plain.includes('.')) plain = plain.replace(/0+$/, '').replace(/\.$/, '')
  plain = plain.replace(/^0+(?=\d)/, '')
  return `${sign}${plain}`
}

export function normalizeTimestampMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('Timestamps must be safe UTC integer milliseconds.')
  return value
}

const SURROGATE = /[\ud800-\udfff]/

function validateScalarText(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1)
      if (!(low >= 0xdc00 && low <= 0xdfff))
        throw new TypeError('Unpaired Unicode surrogate.')
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('Unpaired Unicode surrogate.')
    }
  }
}

/** Code point order; only needed when a key holds surrogate pairs. */
function compareUnicodeScalars(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!)
  const b = Array.from(right, (character) => character.codePointAt(0)!)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

/**
 * Canonical JSON (code point key order, safe integers only, no undefined, no
 * unpaired surrogates). UTF-16 code unit order equals code point order unless
 * a key contains surrogates, so the default sort allocates nothing; keys with
 * surrogates fall back to the explicit code point comparison. Equivalence with
 * the original comparator-only algorithm is pinned by a randomized test.
 */
export function canonicalJson(item: unknown): string {
  if (typeof item === 'string') {
    validateScalarText(item)
    return JSON.stringify(item)
  }
  if (item === null || typeof item === 'boolean') return JSON.stringify(item)
  if (typeof item === 'number') {
    if (!Number.isFinite(item) || !Number.isSafeInteger(item))
      throw new TypeError('Only safe integers are canonical numbers.')
    return String(item)
  }
  if (Array.isArray(item)) {
    let out = '['
    for (let index = 0; index < item.length; index += 1)
      out += (index === 0 ? '' : ',') + canonicalJson(item[index])
    return `${out}]`
  }
  if (typeof item === 'object' && item !== null) {
    const record = item as Record<string, unknown>
    const keys = Object.keys(record)
    let surrogates = false
    for (const key of keys) {
      validateScalarText(key)
      if (!surrogates && SURROGATE.test(key)) surrogates = true
    }
    if (surrogates) keys.sort(compareUnicodeScalars)
    else keys.sort()
    let out = '{'
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!
      if (record[key] === undefined)
        throw new TypeError('Undefined is not canonical.')
      out +=
        (index === 0 ? '' : ',') +
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    }
    return `${out}}`
  }
  throw new TypeError('Unsupported canonical value.')
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
