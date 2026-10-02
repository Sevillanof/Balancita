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
})
