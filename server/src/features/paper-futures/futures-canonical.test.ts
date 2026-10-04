import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
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
