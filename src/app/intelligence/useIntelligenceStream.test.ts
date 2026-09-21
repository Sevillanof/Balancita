import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  parseIntelligenceStreamEvent,
  useIntelligenceStream,
  type IntelligenceStreamEvent,
  type IntelligenceStreamSnapshot,
  type SseEventSource,
} from './useIntelligenceStream'

const snapshot: IntelligenceStreamSnapshot = {
  version: 'intelligence-snapshot.v1',
  instrumentId: 'BTC-EUR',
  generatedAt: 1_700_000_000_000,
  pipeline: {
    status: 'ready',
    collectorEnabled: true,
    connection: 'connected',
    message: 'Market intelligence pipeline is ready.',
  },
  market: {
    source: 'coinbase_exchange',
    instrumentId: 'BTC-EUR',
    status: 'live',
    price: 60_000,
    eventTime: 1_699_999_999_000,
    receivedTime: 1_699_999_999_500,
    displayTime: 1_699_999_999_500,
    freshness: { ageMs: 500, isStale: false, clockInverted: false },
    sequence: 10,
  },
  observability: {
    windowSize: 10,
    latencyMs: { count: 10, p50: 100, p95: 250 },
    stale: { staleCount: 1, totalCount: 10, rate: 0.1 },
    gaps: {
      gapCount: 1,
      expectedOpportunities: 10,
      rate: 0.1,
      sequenceAvailable: true,
    },
  },
  summaries: {
    analysis: { status: 'unavailable', reason: 'not_persisted' },
    forecast: { status: 'unavailable', reason: 'no_forecast' },
    news: { status: 'unavailable', reason: 'no_news' },
  },
}

function event(overrides: Partial<IntelligenceStreamEvent> = {}) {
  return {
    version: 'intelligence-stream.v1',
    type: 'snapshot',
    id: '1',
    serverTime: 1_700_000_000_000,
    snapshot,
    ...overrides,
  } satisfies IntelligenceStreamEvent
}

class FakeEventSource implements SseEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readonly close = vi.fn()
  private listener: ((event: MessageEvent<string>) => void) | undefined
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(
    _name: string,
    listener: (event: MessageEvent<string>) => void,
  ) {
    this.listener = listener
  }

  removeEventListener(
    _name: string,
    listener: (event: MessageEvent<string>) => void,
  ) {
    if (this.listener === listener) this.listener = undefined
  }

  emit(value: unknown) {
    this.listener?.({ data: JSON.stringify(value) } as MessageEvent<string>)
  }
}

const makeSource = (url: string) => new FakeEventSource(url)

describe('useIntelligenceStream', () => {
  it('validates server events and reaches ready, then cleans up', () => {
    FakeEventSource.instances = []
    const { result, unmount } = renderHook(() =>
      useIntelligenceStream({
        url: 'http://127.0.0.1:8787',
        eventSourceFactory: makeSource,
      }),
    )

    expect(result.current.status).toBe('loading')
    const source = FakeEventSource.instances[0]!
    act(() => source.onopen?.())
    act(() => source.emit(event()))
    expect(result.current.status).toBe('ready')
    expect(result.current.snapshot?.market?.price).toBe(60_000)

    unmount()
    expect(source.close).toHaveBeenCalledTimes(1)
  })

  it('moves to error and reconnects with bounded backoff', () => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    const { result } = renderHook(() =>
      useIntelligenceStream({
        url: 'http://127.0.0.1:8787',
        eventSourceFactory: makeSource,
        reconnectMinMs: 100,
        reconnectMaxMs: 200,
      }),
    )
    const first = FakeEventSource.instances[0]!
    act(() => first.onerror?.())
    expect(result.current.status).toBe('error')
    act(() => vi.advanceTimersByTime(100))
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(result.current.reconnectAttempt).toBe(1)
    vi.useRealTimers()
  })

  it('rejects malformed event payloads at the runtime boundary', () => {
    expect(() => parseIntelligenceStreamEvent({ type: 'snapshot' })).toThrow(
      'Evento SSE de inteligencia inválido',
    )
  })
})
