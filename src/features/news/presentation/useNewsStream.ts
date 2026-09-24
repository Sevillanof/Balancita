import type {
  SseEventSource,
  UseIntelligenceStreamResult,
} from './useIntelligenceStream.ts'
import { useIntelligenceStream } from './useIntelligenceStream.ts'
import type { NewsItem, NewsStatus } from './news-fixtures.ts'

export type UseNewsStreamResult = {
  readonly status: NewsStatus
  readonly items: readonly NewsItem[]
  readonly error: Error | null
  readonly stream: UseIntelligenceStreamResult
}

type NewsWireItem = {
  readonly id: string
  readonly version: string
  readonly source: string
  readonly title: string
  readonly url: string
  readonly publishedAt: number
  readonly ingestedAt: number
  readonly displayedAt: number
  readonly licenseStatus: string
  readonly important: boolean
  readonly summary: string
  readonly tradeIntent: 'buy' | 'sell' | 'neutral'
  readonly freshness: { readonly ageMs: number; readonly isStale: boolean }
}

export function useNewsStream(
  options: {
    readonly url?: string
    readonly eventSourceFactory?: (url: string) => SseEventSource
    readonly reconnectMinMs?: number
    readonly reconnectMaxMs?: number
  } = {},
): UseNewsStreamResult {
  const stream = useIntelligenceStream(options)
  const news = stream.snapshot?.news
  if (stream.status === 'loading')
    return { status: 'loading', items: [], error: stream.error, stream }
  if (stream.status === 'error')
    return {
      status: 'error',
      items: itemsForToday(news?.items.map(toNewsItem) ?? [], stream.snapshot),
      error: stream.error,
      stream,
    }
  if (stream.status === 'stale')
    return {
      status: 'stale',
      items: itemsForToday(news?.items.map(toNewsItem) ?? [], stream.snapshot),
      error: null,
      stream,
    }
  if (news === undefined || news.status === 'disabled')
    return { status: 'empty', items: [], error: null, stream }
  if (news.status === 'loading')
    return { status: 'loading', items: [], error: null, stream }
  if (news.status === 'error')
    return {
      status: 'error',
      items: itemsForToday(news.items.map(toNewsItem), stream.snapshot),
      error:
        news.error === undefined
          ? new Error('News polling failed.')
          : new Error(news.error),
      stream,
    }
  if (news.status === 'stale')
    return {
      status: 'stale',
      items: itemsForToday(news.items.map(toNewsItem), stream.snapshot),
      error: null,
      stream,
    }
  const items = itemsForToday(news.items.map(toNewsItem), stream.snapshot)
  return {
    status: items.length === 0 ? 'empty' : 'ready',
    items,
    error: null,
    stream,
  }
}

function toNewsItem(item: NewsWireItem): NewsItem {
  return {
    id: item.id,
    version: item.version,
    source: item.source,
    title: item.title,
    url: item.url,
    publishedAt: new Date(item.publishedAt).toISOString(),
    ingestedAt: new Date(item.ingestedAt).toISOString(),
    displayedAt: new Date(item.displayedAt).toISOString(),
    licenseStatus: item.licenseStatus as NewsItem['licenseStatus'],
    important: item.important,
    summary: item.summary,
    tradeIntent: item.tradeIntent,
    freshness: item.freshness,
  }
}

function itemsForToday(
  items: readonly NewsItem[],
  snapshot: { readonly generatedAt: number } | null,
): readonly NewsItem[] {
  const reference = snapshot?.generatedAt ?? Date.now()
  const referenceDate = new Date(reference)
  const start = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  )
  const end = start + 86_400_000
  return items.filter((item) => {
    const publishedAt = Date.parse(item.publishedAt)
    return publishedAt >= start && publishedAt < end
  })
}
