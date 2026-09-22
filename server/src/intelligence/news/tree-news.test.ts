import { afterEach, describe, expect, it } from 'vitest'
import { MarketStore } from '../market/market-store.ts'
import { NewsPollingService } from './news-poller.ts'
import {
  parseTreeNewsEvent,
  TREE_NEWS_SOURCE,
  TreeNewsService,
  type TreeNewsSocket,
} from './tree-news.ts'

class FakeSocket implements TreeNewsSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  emit(data: unknown): void {
    this.onmessage?.({ data })
  }

  emitClose(): void {
    this.onclose?.()
  }

  close(): void {
    this.closed = true
  }
}

describe('Tree News service', () => {
  const stores: MarketStore[] = []

  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
  })

  it('parses documented and defensive event shapes', () => {
    expect(
      parseTreeNewsEvent(
        JSON.stringify({
          _id: 'tree-1',
          title: 'Bitcoin and EUR headline',
          body: 'Short source summary.',
          source: 'Example Desk',
          link: 'https://news.example.test/tree-1',
          time: 1_750_000_000_000,
          importance: 'high',
          intent: 'buy',
        }),
      ),
    ).toMatchObject({
      sourceId: TREE_NEWS_SOURCE.sourceId,
      sourceItemId: 'tree-1',
      category: 'Example Desk',
      sourceSummary: 'Short source summary.',
      important: true,
      tradeIntent: 'buy',
    })
    expect(
      parseTreeNewsEvent({
        data: {
          title: 'Nested headline',
          url: 'https://news.example.test/nested',
          time: '2026-09-22T10:00:00.000Z',
        },
      }),
    ).toMatchObject({ title: 'Nested headline' })
    expect(parseTreeNewsEvent('{not-json}')).toBeUndefined()
    expect(parseTreeNewsEvent({ title: 'No URL' })).toBeUndefined()
  })

  it('reconnects with bounded backoff and lets the store deduplicate and version corrections', async () => {
    const store = new MarketStore({ path: ':memory:' })
    stores.push(store)
    const poller = new NewsPollingService({
      store,
      sources: [],
      normalizerSources: [TREE_NEWS_SOURCE],
      userAgent: 'Balancita/test',
      clock: () => Date.parse('2026-09-22T12:00:00.000Z') as never,
      staleAfterMs: 60_000,
    })
    const sockets: FakeSocket[] = []
    const delays: number[] = []
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
    const pending: Promise<unknown>[] = []
    let timerId = 0
    const service = new TreeNewsService({
      enabled: true,
      url: 'wss://news.example.test/ws',
      reconnectMinMs: 100,
      reconnectMaxMs: 200,
      clock: () => Date.parse('2026-09-22T12:00:00.000Z') as never,
      socketFactory: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      setTimeout: (callback, delayMs) => {
        delays.push(delayMs)
        const handle = { id: ++timerId } as unknown as ReturnType<
          typeof setTimeout
        >
        timers.set(handle, callback)
        return handle
      },
      clearTimeout: (handle) => {
        timers.delete(handle)
      },
      onItem: (item) => {
        const result = poller.ingestExternal([item], TREE_NEWS_SOURCE.sourceId)
        pending.push(result)
      },
    })

    service.start()
    sockets[0]?.onopen?.()
    const original = JSON.stringify({
      _id: 'tree-dedupe-1',
      title: 'Bitcoin and EUR headline',
      body: 'Original summary.',
      link: 'https://news.example.test/tree-dedupe-1',
      time: '2026-09-22T11:00:00.000Z',
    })
    sockets[0]?.emit(original)
    sockets[0]?.emit(original)
    await Promise.all(pending.splice(0))
    expect(store.newsEvidenceCount()).toBe(1)

    sockets[0]?.emitClose()
    expect(delays).toEqual([100])
    const reconnect = [...timers.values()][0]
    reconnect?.()
    expect(sockets).toHaveLength(2)

    sockets[1]?.emit(
      JSON.stringify({
        _id: 'tree-dedupe-1',
        title: 'Corrected Bitcoin and EUR headline',
        link: 'https://news.example.test/tree-dedupe-1',
        time: '2026-09-22T11:00:00.000Z',
      }),
    )
    await Promise.all(pending.splice(0))
    expect(store.newsEvidenceCount()).toBe(2)
    expect(
      store.listNewsEvidence({ usableOnly: true })[0]?.metadata.title,
    ).toBe('Corrected Bitcoin and EUR headline')

    service.stop()
    expect(sockets[1]?.closed).toBe(true)
  })
})
