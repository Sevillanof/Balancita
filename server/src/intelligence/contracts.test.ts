import { describe, expect, it } from 'vitest'
import {
  parseTimestampMs,
  type MarketDataCollector,
  type MarketDataNormalizer,
  type MarketDataEnvelope,
  type SupportedInstrumentId,
  type NewsCollector,
  type NewsNormalizer,
  validateMarketDataEnvelope,
} from './contracts.ts'

const timestamp = (value: number) => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

describe('intelligence contracts', () => {
  it('accepts only finite non-negative integer epoch milliseconds', () => {
    expect(parseTimestampMs(1_700_000_000_000).valid).toBe(true)
    expect(parseTimestampMs(1.5).valid).toBe(false)
    expect(parseTimestampMs(-1).valid).toBe(false)
    expect(parseTimestampMs(Number.NaN).valid).toBe(false)
    expect(parseTimestampMs(Number.POSITIVE_INFINITY).valid).toBe(false)
  })

  it('keeps collector and normalizer contracts scoped to BTC-EUR', async () => {
    const collector: MarketDataCollector<string> = {
      domain: 'market',
      source: 'fixture',
      collect: async (_instrumentId: SupportedInstrumentId) => {
        void _instrumentId
        return ['raw']
      },
    }
    const normalizer: MarketDataNormalizer<string, { price: number }> = {
      domain: 'market',
      normalize: ({ raw, instrumentId, receivedTime, displayTime }) => ({
        valid: true,
        value: {
          source: collector.source,
          symbol: instrumentId,
          instrumentId,
          eventTime: receivedTime,
          receivedTime,
          displayTime,
          payload: { price: Number(raw.length) },
          status: 'live',
          freshness: { ageMs: 0, isStale: false, clockInverted: false },
        },
      }),
    }

    expect(collector.domain).toBe('market')
    expect(normalizer.domain).toBe('market')
    await expect(collector.collect('BTC-EUR')).resolves.toEqual(['raw'])
  })

  it('rejects a market envelope with inconsistent derived freshness', () => {
    const envelope: MarketDataEnvelope<{ price: number }> = {
      source: 'fixture',
      symbol: 'BTC-EUR',
      instrumentId: 'BTC-EUR',
      eventTime: timestamp(1_000),
      receivedTime: timestamp(1_100),
      displayTime: timestamp(1_500),
      payload: { price: 100 },
      status: 'live',
      freshness: { ageMs: 500, isStale: false, clockInverted: false },
    }

    const result = validateMarketDataEnvelope({
      ...envelope,
      freshness: { ageMs: 1, isStale: false, clockInverted: false },
    })

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        'freshness_mismatch',
      )
    }
  })

  it('exposes news collector and normalizer contracts with provenance in the result', () => {
    const collector: NewsCollector<{ title: string }> = {
      domain: 'news',
      source: 'fixture',
      collect: async () => [{ title: 'BTC-EUR' }],
    }
    const normalizer: NewsNormalizer<{ title: string }> = {
      domain: 'news',
      normalize: ({ raw, evidence }) => ({
        valid: true,
        value: {
          instrumentId: 'BTC-EUR',
          status: 'live',
          evidence: {
            ...evidence,
            content: { kind: 'excerpt', text: raw.title },
          },
        },
      }),
    }

    expect(collector.domain).toBe('news')
    expect(normalizer.domain).toBe('news')
  })
})
