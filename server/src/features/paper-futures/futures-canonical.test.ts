import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalHash,
  canonicalJson,
  normalizeDecimal,
} from './futures-canonical.ts'

describe('futures canonical identity', () => {
  it('matches shared Python vectors', () => {
    const vectors = JSON.parse(
      readFileSync(
        new URL(
          '../../../../python/fixtures/futures-canonical-vectors.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { value: unknown; canonical: string; sha256: string }[]
    for (const vector of vectors) {
      expect(canonicalJson(vector.value)).toBe(vector.canonical)
      expect(canonicalHash(vector.value)).toBe(vector.sha256)
      expect(createHash('sha256').update(vector.canonical).digest('hex')).toBe(
        vector.sha256,
      )
    }
  })
  it('normalizes typed decimals and rejects unsupported values', () => {
    expect(normalizeDecimal('-0.000')).toBe('0')
    expect(normalizeDecimal('1E+3')).toBe('1000')
    expect(() => normalizeDecimal(1.2)).toThrow()
    expect(() => canonicalJson({ value: Number.NaN })).toThrow()
  })

  it('rejects unpaired surrogates while agreeing on supplementary Unicode vectors', () => {
    const vectors = JSON.parse(
      readFileSync(
        new URL(
          '../../../../python/fixtures/futures-canonical-vectors.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { name: string; value: unknown; canonical: string; sha256: string }[]
    const supplementary = vectors.find(
      (vector) => vector.name === 'unicode-order-and-supplementary',
    )!
    expect(canonicalJson(supplementary.value)).toBe(supplementary.canonical)
    expect(canonicalHash(supplementary.value)).toBe(supplementary.sha256)
    const invalid = JSON.parse(
      readFileSync(
        new URL(
          '../../../../python/fixtures/futures-canonical-invalid.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { unpaired: unknown }
    expect(() => canonicalJson(invalid.unpaired)).toThrow()
    expect(() => normalizeDecimal('1'.repeat(5000))).toThrow()
  })
})

/** The pre-consolidation algorithm, kept verbatim as the reference oracle. */
function referenceCanonicalJson(value: unknown): string {
  const validateUnicode = (text: string): void => {
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
  const compare = (left: string, right: string): number => {
    const a = Array.from(left, (character) => character.codePointAt(0)!)
    const b = Array.from(right, (character) => character.codePointAt(0)!)
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index]! - b[index]!
    }
    return a.length - b.length
  }
  const encode = (item: unknown): string => {
    if (typeof item === 'string') {
      validateUnicode(item)
      return JSON.stringify(item)
    }
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || !Number.isSafeInteger(item))
        throw new TypeError('Only safe integers are canonical numbers.')
      return String(item)
    }
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`
    if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>
      return `{${Object.keys(record)
        .map((key) => {
          validateUnicode(key)
          return key
        })
        .sort(compare)
        .map((key) => {
          if (record[key] === undefined)
            throw new TypeError('Undefined is not canonical.')
          return `${JSON.stringify(key)}:${encode(record[key])}`
        })
        .join(',')}}`
    }
    throw new TypeError('Unsupported canonical value.')
  }
  return encode(value)
}

describe('canonicalJson equals the reference algorithm', () => {
  // Deterministic PRNG so failures reproduce.
  let state = 0x9e3779b9
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!
  const ALPHABET = [
    'a',
    'b',
    'Z',
    '0',
    '_',
    'é',
    '￿',
    '😀', // U+1F600 (surrogate pair)
    '𐀀', // U+10000
    '', // BMP above the surrogate block
    '\ud800', // lone high
    '\udc00', // lone low
  ]
  const text = () =>
    Array.from({ length: Math.floor(random() * 4) }, () => pick(ALPHABET)).join(
      '',
    )
  const scalar = (): unknown =>
    pick([
      () => text(),
      () => Math.floor(random() * 2_000_000) - 1_000_000,
      () => null,
      () => random() < 0.5,
      () => 0.5, // unsafe
      () => undefined,
      () => Number.NaN,
    ])()
  const tree = (depth: number): unknown => {
    if (depth === 0 || random() < 0.3) return scalar()
    if (random() < 0.4)
      return Array.from({ length: Math.floor(random() * 4) }, () =>
        tree(depth - 1),
      )
    const out: Record<string, unknown> = {}
    for (let index = Math.floor(random() * 6); index > 0; index -= 1)
      out[text()] = tree(depth - 1)
    return out
  }
  const outcome = (fn: (value: unknown) => string, value: unknown) => {
    try {
      return { ok: fn(value) }
    } catch (error) {
      return {
        error: (error as Error).constructor.name + (error as Error).message,
      }
    }
  }

  it('agrees on 5000 random values, including surrogate keys and errors', () => {
    let errors = 0
    let successes = 0
    for (let index = 0; index < 5000; index += 1) {
      const value = tree(3)
      const expected = outcome(referenceCanonicalJson, value)
      expect(outcome(canonicalJson, value)).toEqual(expected)
      if ('error' in expected) errors += 1
      else successes += 1
    }
    expect(errors).toBeGreaterThan(100)
    expect(successes).toBeGreaterThan(500)
  })

  it('orders supplementary keys after BMP keys above the surrogate block', () => {
    const value = { '😀': 1, '￿': 2, '': 3, a: 4 }
    expect(canonicalJson(value)).toBe(referenceCanonicalJson(value))
    expect(canonicalJson(value).indexOf('😀')).toBeGreaterThan(
      canonicalJson(value).indexOf('￿'),
    )
  })

  it('does not allocate per key comparison', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`key-${(i * 37) % 200}`, i]),
    )
    const spy = vi.spyOn(Array, 'from')
    try {
      canonicalJson(wide)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
