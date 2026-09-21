import { describe, expect, it, vi } from 'vitest'
import { deriveDataFreshness } from './slis.ts'
import {
  createIntelligenceSnapshot,
  IntelligenceStreamHub,
  parseIntelligenceStreamEvent,
  type IntelligenceStreamSnapshot,
} from './stream.ts'
import { MarketStore } from './market/market-store.ts'

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

  it('rejects malformed wire events before the UI can consume them', () => {
    expect(() => parseIntelligenceStreamEvent({ nope: true })).toThrow(
      'Invalid intelligence stream event',
    )
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
