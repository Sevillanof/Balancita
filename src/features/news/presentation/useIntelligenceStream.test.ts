import { renderHook, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseIntelligenceStreamEvent,
  useIntelligenceStream,
  type IntelligenceStreamEvent,
  type IntelligenceStreamSnapshot,
  type SseEventSource,
} from './useIntelligenceStream.ts'

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
    source: 'kraken',
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

afterEach(() => vi.unstubAllEnvs())

describe('useIntelligenceStream', () => {
  it('uses the same-origin stream route when no URL override is configured', () => {
    FakeEventSource.instances = []
    vi.stubEnv('VITE_INTELLIGENCE_SERVER_URL', 'http://127.0.0.1:8787')
    vi.stubEnv('VITE_GEMINI_SERVER_URL', 'http://localhost:8787')
    const { unmount } = renderHook(() =>
      useIntelligenceStream({ eventSourceFactory: makeSource }),
    )

    expect(FakeEventSource.instances[0]?.url).toBe(
      '/api/intelligence/stream?instrumentId=BTC-EUR',
    )
    unmount()
  })

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
    expect(source.url).toBe(
      'http://127.0.0.1:8787/api/intelligence/stream?instrumentId=BTC-EUR',
    )
    act(() => source.onopen?.())
    act(() => source.emit(event()))
    expect(result.current.status).toBe('ready')
    expect(result.current.snapshot?.market?.price).toBe(60_000)

    unmount()
    expect(source.close).toHaveBeenCalledTimes(1)
  })

  it('records browser receipt time independently from server snapshot time', () => {
    FakeEventSource.instances = []
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const { result } = renderHook(() =>
      useIntelligenceStream({ eventSourceFactory: makeSource }),
    )

    act(() => FakeEventSource.instances[0]!.emit(event()))

    expect(result.current.clientReceivedAtMs).toBe(1_800_000_000_000)
    expect(result.current.snapshot?.generatedAt).toBe(1_700_000_000_000)
    vi.restoreAllMocks()
  })

  it('moves to error and reconnects with bounded backoff', () => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    const { result, unmount } = renderHook(() =>
      useIntelligenceStream({
        url: 'http://127.0.0.1:8787',
        eventSourceFactory: makeSource,
        reconnectMinMs: 100,
        reconnectMaxMs: 200,
      }),
    )
    const first = FakeEventSource.instances[0]!
    expect(result.current.transportStatus).toBe('connecting')
    act(() => first.onopen?.())
    expect(result.current.transportStatus).toBe('connected')
    act(() => first.onerror?.())
    expect(result.current.status).toBe('loading')
    expect(result.current.transportStatus).toBe('reconnecting')
    act(() => vi.advanceTimersByTime(100))
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(result.current.reconnectAttempt).toBe(1)
    expect(result.current.transportStatus).toBe('connecting')
    act(() => FakeEventSource.instances[1]!.onopen?.())
    expect(result.current.transportStatus).toBe('connected')
    unmount()
    vi.useRealTimers()
  })

  it('keeps browser transport independent from collector connection status', () => {
    FakeEventSource.instances = []
    const { result, unmount } = renderHook(() =>
      useIntelligenceStream({ eventSourceFactory: makeSource }),
    )
    const source = FakeEventSource.instances[0]!

    act(() => source.onopen?.())
    act(() =>
      source.emit(
        event({
          snapshot: {
            ...snapshot,
            pipeline: { ...snapshot.pipeline, connection: 'reconnecting' },
          },
        }),
      ),
    )
    expect(result.current.transportStatus).toBe('connected')
    expect(result.current.status).toBe('ready')
    expect(result.current.snapshot?.pipeline.connection).toBe('reconnecting')

    act(() => source.onerror?.())
    expect(result.current.transportStatus).toBe('reconnecting')
    expect(result.current.status).toBe('ready')
    expect(result.current.snapshot?.pipeline.connection).toBe('reconnecting')
    unmount()
  })

  it('rejects malformed event payloads at the runtime boundary', () => {
    expect(() => parseIntelligenceStreamEvent({ type: 'snapshot' })).toThrow(
      'Evento SSE de inteligencia inválido',
    )
  })
})
