import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNewsStream } from './useNewsStream.ts'
import type {
  IntelligenceStreamEvent,
  IntelligenceStreamSnapshot,
  SseEventSource,
} from './useIntelligenceStream.ts'

const snapshot: IntelligenceStreamSnapshot = {
  version: 'intelligence-snapshot.v1',
  instrumentId: 'BTC-EUR',
  generatedAt: Date.parse('2026-09-22T17:30:00.000Z'),
  pipeline: {
    status: 'ready',
    collectorEnabled: true,
    connection: 'connected',
    message: 'Market intelligence pipeline is ready.',
  },
  market: null,
  observability: null,
  summaries: {
    analysis: { status: 'unavailable', reason: 'not_persisted' },
    forecast: { status: 'unavailable', reason: 'no_forecast' },
    news: { status: 'unavailable', reason: 'no_news' },
  },
  news: {
    status: 'ready',
    items: [
      {
        id: 'news:sec:item',
        version: '1',
        source: 'sec',
        title: 'Bitcoin and EUR market structure',
        url: 'https://www.sec.gov/news/item',
        publishedAt: Date.parse('2026-09-22T17:29:59.000Z'),
        ingestedAt: Date.parse('2026-09-22T17:29:59.500Z'),
        displayedAt: Date.parse('2026-09-22T17:30:00.000Z'),
        licenseStatus: 'official_public',
        important: true,
        summary: 'Resumen de la estructura de mercado de Bitcoin y EUR.',
        tradeIntent: 'neutral',
        freshness: { ageMs: 500, isStale: false },
      },
    ],
  },
}

class FakeEventSource implements SseEventSource {
  static instances: FakeEventSource[] = []
  readonly close = vi.fn()
  readonly url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private listener: ((event: MessageEvent<string>) => void) | undefined

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(
    _name: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    this.listener = listener
  }

  removeEventListener(
    _name: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    if (this.listener === listener) this.listener = undefined
  }

  emit(event: IntelligenceStreamEvent): void {
    this.listener?.({ data: JSON.stringify(event) } as MessageEvent<string>)
  }
}

function event(snapshotValue: IntelligenceStreamSnapshot = snapshot) {
  return {
    version: 'intelligence-stream.v1',
    type: 'snapshot',
    id: '1',
    serverTime: 1_700_000_000_000,
    snapshot: snapshotValue,
  } satisfies IntelligenceStreamEvent
}

const makeSource = (url: string) => new FakeEventSource(url)

describe('useNewsStream', () => {
  it('maps validated SSE news to ready and cleans up one connection', () => {
    FakeEventSource.instances = []
    const { result, unmount } = renderHook(() =>
      useNewsStream({
        url: 'http://127.0.0.1:8787',
        eventSourceFactory: makeSource,
      }),
    )

    const source = FakeEventSource.instances[0]!
    act(() => source.onopen?.())
    act(() => source.emit(event()))
    expect(result.current.status).toBe('ready')
    expect(result.current.stream.transportStatus).toBe('connected')
    expect(result.current.items[0]).toMatchObject({
      source: 'sec',
      ingestedAt: '2026-09-22T17:29:59.500Z',
      displayedAt: '2026-09-22T17:30:00.000Z',
      licenseStatus: 'official_public',
      summary: 'Resumen de la estructura de mercado de Bitcoin y EUR.',
      tradeIntent: 'neutral',
    })

    unmount()
    expect(source.close).toHaveBeenCalledTimes(1)
  })

  it('reconnects with bounded backoff and rejects malformed news payloads', () => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    const { result } = renderHook(() =>
      useNewsStream({
        url: 'http://127.0.0.1:8787',
        eventSourceFactory: makeSource,
        reconnectMinMs: 100,
        reconnectMaxMs: 200,
      }),
    )
    const first = FakeEventSource.instances[0]!
    act(() =>
      first.emit(
        event({
          ...snapshot,
          news: { status: 'ready', items: [{ invalid: true }] },
        } as unknown as IntelligenceStreamSnapshot),
      ),
    )
    expect(result.current.status).toBe('loading')
    expect(result.current.stream.transportStatus).toBe('reconnecting')
    expect(result.current.error).toBeInstanceOf(Error)
    act(() => vi.advanceTimersByTime(100))
    expect(FakeEventSource.instances).toHaveLength(2)
    vi.useRealTimers()
  })
})
