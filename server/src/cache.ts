import { createHash } from 'node:crypto'
import type { AnalysisInputRequest, AnalysisResultJson } from './wire.ts'

/**
 * Stable fingerprint of an analysis input, used to serve repeated requests
 * from the cache and avoid paying for identical calls. The object is rebuilt
 * with a fixed key order so the digest never depends on insertion order.
 */
export function hashAnalysisInput(input: AnalysisInputRequest): string {
  const canonical = {
    instrumentId: input.instrumentId,
    symbol: input.symbol,
    assetClass: input.assetClass,
    currency: input.currency,
    quote: input.quote,
    candles: input.candles,
    holding: input.holding,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/**
 * Bounded in-memory response cache. Order of insertion is eviction order: the
 * oldest key is dropped once the capacity is reached.
 */
export class AnalysisCache {
  private readonly maxEntries: number
  private readonly store = new Map<string, AnalysisResultJson>()

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('Cache capacity must be a positive integer.')
    }
    this.maxEntries = maxEntries
  }

  get size(): number {
    return this.store.size
  }

  get(key: string): AnalysisResultJson | undefined {
    const stored = this.store.get(key)
    if (stored === undefined) return undefined
    return {
      instrumentId: stored.instrumentId,
      classification: stored.classification,
      reasons: [...stored.reasons],
      warnings: [...stored.warnings],
      volatility: { ...stored.volatility },
    }
  }

  set(key: string, result: AnalysisResultJson): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    }
    this.store.set(key, result)
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) {
        this.store.delete(oldest)
      }
    }
  }
}
