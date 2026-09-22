import { describe, expect, it, vi } from 'vitest'
import type { NewsEvidence, TimestampMs } from './contracts.ts'
import { deriveDataFreshness } from './slis.ts'
import {
  createIntelligenceSnapshot,
  IntelligenceStreamHub,
  parseIntelligenceStreamEvent,
  type IntelligenceStreamSnapshot,
} from './stream.ts'
import { MarketStore } from './market/market-store.ts'
import { contentHashForNewsEvidence } from './news/rss-normalizer.ts'

const now = 1_700_000_000_000

function envelope(eventTime: number, receivedTime: number, sequence: number) {
  const freshness = deriveDataFreshness({
    eventTime: eventTime as never,
    displayTime: receivedTime as never,
    staleAfterMs: 15_000,
  })
  if (!freshness.valid) throw new Error('fixture freshness is invalid')
  return {
    source: 'kraken',
    symbol: 'BTC-EUR',
    instrumentId: 'BTC-EUR',
    eventTime,
    receivedTime,
    displayTime: receivedTime,
    sequence,
    status: freshness.value.isStale ? 'stale' : 'live',
    freshness: freshness.value,
    payload: {
      type: 'ticker',
      productId: 'BTC-EUR',
      tradeId: sequence,
      sequence,
      price: 60_000 + sequence,
    },
  }
}

function tradeEnvelope(
  eventTime: number,
  receivedTime: number,
  tradeId: number,
) {
  const freshness = deriveDataFreshness({
    eventTime: eventTime as never,
    displayTime: receivedTime as never,
    staleAfterMs: 15_000,
  })
  if (!freshness.valid) throw new Error('fixture freshness is invalid')
  return {
    source: 'kraken',
    symbol: 'BTC-EUR',
    instrumentId: 'BTC-EUR',
    eventTime,
    receivedTime,
    displayTime: receivedTime,
    sequence: tradeId,
    status: freshness.value.isStale ? 'stale' : 'live',
    freshness: freshness.value,
    payload: {
      type: 'trade',
      productId: 'BTC-EUR',
      tradeId,
      sequence: tradeId,
      price: 61_000 + tradeId,
      qty: 0.25,
      side: 'buy',
    },
  }
}

function parseEvent(chunk: string) {
  const data = chunk
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length)
  if (data === undefined) throw new Error('missing SSE data')
  return JSON.parse(data) as unknown
}

describe('intelligence SSE contract', () => {
  it('reports disabled without inventing market or SLI data', () => {
    const snapshot = createIntelligenceSnapshot({
      collectorEnabled: false,
      staleAfterMs: 15_000,
      clock: () => now,
    })

    expect(snapshot.pipeline).toMatchObject({
      status: 'disabled',
      connection: 'disabled',
    })
    expect(snapshot.market).toBeNull()
    expect(snapshot.observability).toBeNull()
    expect(snapshot.summaries.forecast.status).toBe('unavailable')
  })

  it('derives latest market timestamps and SLIs from the store', () => {
    const store = new MarketStore({
      path: ':memory:',
      clock: () => now as never,
    })
    store.insertObservation(envelope(now - 1_000, now - 500, 1) as never)
    store.insertObservation(envelope(now - 3_000, now - 400, 2) as never)

    const snapshot = createIntelligenceSnapshot({
      collectorEnabled: true,
      marketStore: store,
      staleAfterMs: 15_000,
      clock: () => now,
    })

    expect(snapshot.pipeline.status).toBe('unavailable')
    expect(snapshot.market).toMatchObject({
      price: 60_002,
      eventTime: now - 3_000,
      receivedTime: now - 400,
      displayTime: now - 400,
    })
    expect(snapshot.observability).toMatchObject({
      latencyMs: { count: 2, p50: 500, p95: 2_600 },
      stale: { totalCount: 2, staleCount: 0, rate: 0 },
    })

    const evidence: NewsEvidence = {
      instrumentId: 'BTC-EUR',
      source: 'sec',
      sourceLevel: 'official_primary',
      sourceItemId: 'sec-stream-1',
      url: 'https://www.sec.gov/newsroom/press-releases/stream-1',
      publishedAt: (now - 2_000) as TimestampMs,
      ingestedAt: (now - 1_000) as TimestampMs,
      retrievedAt: (now - 900) as TimestampMs,
      contentHash: '',
      licenseStatus: 'official_public',
      correctionStatus: 'original',
      relevance: 'relevant',
      relevanceRuleVersion: 'news-relevance.v1',
      taxonomy: 'market_structure',
      taxonomyRuleVersion: 'news-taxonomy.v1',
      metadata: { title: 'Bitcoin and EUR market structure update' },
      content: { kind: 'metadata_only' },
    }
    store.insertNewsEvidence({
      ...evidence,
      contentHash: contentHashForNewsEvidence(evidence),
    })
    const withNews = createIntelligenceSnapshot({
      collectorEnabled: true,
      marketStore: store,
      staleAfterMs: 15_000,
      clock: () => now,
    })
    expect(withNews.news).toMatchObject({
      status: 'ready',
      items: [
        {
          source: 'sec',
          url: evidence.url,
          publishedAt: evidence.publishedAt,
          ingestedAt: evidence.ingestedAt,
          displayedAt: now,
          licenseStatus: 'official_public',
          title: 'Bitcoin and EUR market structure update',
          important: true,
        },
      ],
    })
    store.close()
  })

  it('derives the latest market snapshot from Kraken trade-native payloads', () => {
    const store = new MarketStore({
      path: ':memory:',
      clock: () => now as never,
    })
    store.insertObservation(tradeEnvelope(now - 1_000, now - 500, 42) as never)

    const snapshot = createIntelligenceSnapshot({
      collectorEnabled: true,
      marketStore: store,
      staleAfterMs: 15_000,
      clock: () => now,
    })

    expect(snapshot.market).toMatchObject({
      source: 'kraken',
      instrumentId: 'BTC-EUR',
      price: 61_042,
      sequence: 42,
      eventTime: now - 1_000,
      receivedTime: now - 500,
    })
    store.close()
  })

  it('scopes gap detection to the current source and observation window', () => {
    const store = new MarketStore({
      path: ':memory:',
      clock: () => now as never,
    })
    store.insertObservation(envelope(now - 1_000, now - 500, 1) as never)
    store.insertObservation(envelope(now - 3_000, now - 400, 2) as never)
    const collector = { getStatus: () => 'connected' as const }
    const snapshot = () =>
      createIntelligenceSnapshot({
        collectorEnabled: true,
        collector,
        marketStore: store,
        staleAfterMs: 15_000,
        clock: () => now,
      })

    // A legacy venue's gap must not leak into the Kraken-era pipeline status.
    store.recordGap({
      source: 'coinbase_exchange',
      instrumentId: 'BTC-EUR',
      prevSequence: 1,
      currentSequence: 5,
      detectedAt: (now - 1_000) as never,
      evidence: { kind: 'trade_id' },
    })
    const withLegacyGap = snapshot()
    expect(withLegacyGap.pipeline.status).toBe('ready')
    expect(withLegacyGap.observability?.gaps.gapCount).toBe(0)

    // A Kraken gap inside the observation window still surfaces as a gap.
    store.recordGap({
      source: 'kraken',
      instrumentId: 'BTC-EUR',
      prevSequence: 2,
      currentSequence: 6,
      detectedAt: (now - 500) as never,
      evidence: { kind: 'trade_id' },
    })
    const withCurrentGap = snapshot()
    expect(withCurrentGap.pipeline.status).toBe('gap')
    expect(withCurrentGap.observability?.gaps.gapCount).toBe(1)
    store.close()
  })

  it('rejects malformed wire events before the UI can consume them', () => {
    expect(() => parseIntelligenceStreamEvent({ nope: true })).toThrow(
      'Invalid intelligence stream event',
    )
  })

  it('rejects malformed news items while accepting legacy snapshots without news', () => {
    expect(() =>
      parseIntelligenceStreamEvent({
        version: 'intelligence-stream.v1',
        type: 'snapshot',
        id: '1',
        serverTime: now,
        snapshot: {
          ...createIntelligenceSnapshot({
            collectorEnabled: false,
            staleAfterMs: 15_000,
            clock: () => now,
          }),
          news: { status: 'ready', items: [{ invalid: true }] },
        },
      }),
    ).toThrow('Invalid intelligence stream event')

    expect(() =>
      parseIntelligenceStreamEvent({
        version: 'intelligence-stream.v1',
        type: 'snapshot',
        id: 'legacy',
        serverTime: now,
        snapshot: {
          ...createIntelligenceSnapshot({
            collectorEnabled: false,
            staleAfterMs: 15_000,
            clock: () => now,
          }),
        },
      }),
    ).not.toThrow()
  })
})

describe('IntelligenceStreamHub', () => {
  function snapshot(): IntelligenceStreamSnapshot {
    return {
      version: 'intelligence-snapshot.v1',
      instrumentId: 'BTC-EUR',
      generatedAt: now as never,
      pipeline: {
        status: 'disabled',
        collectorEnabled: false,
        connection: 'disabled',
        message: 'Market collector is disabled.',
      },
      market: null,
      observability: null,
      summaries: {
        analysis: { status: 'unavailable', reason: 'not_persisted' },
        forecast: { status: 'unavailable', reason: 'no_forecast' },
        news: { status: 'unavailable', reason: 'no_news' },
      },
    }
  }

  it('sends an initial snapshot, keepalive and cleans up clients', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const hub = new IntelligenceStreamHub({
      snapshot,
      maxClients: 1,
      keepAliveMs: 1_000,
      clock: () => now,
    })

    const cleanup = hub.connect({
      write: (chunk) => {
        writes.push(chunk)
        return true
      },
    })
    expect(writes[0]).toContain('event: intelligence.snapshot')
    expect(parseEvent(writes[0]!)).toMatchObject({ type: 'snapshot' })
    vi.advanceTimersByTime(1_000)
    expect(writes.at(-1)).toBe(': keepalive\n\n')
    cleanup()
    expect(hub.clientCount()).toBe(0)
    vi.useRealTimers()
  })

  it('bounds clients and removes sinks that apply backpressure', () => {
    const hub = new IntelligenceStreamHub({
      snapshot,
      maxClients: 1,
      keepAliveMs: 10_000,
      clock: () => now,
    })
    const first = hub.connect({ write: () => true })
    expect(() => hub.connect({ write: () => true })).toThrow(
      'SSE client limit reached',
    )
    first()

    const second = hub.connect({ write: () => false })
    expect(hub.clientCount()).toBe(0)
    second()
  })
})
