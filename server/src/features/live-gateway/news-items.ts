import { withDb, num, rowOf, type Row } from './observability-health.ts'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const RELEVANCE = new Set(['high', 'medium', 'low', 'none'] as const)
const DIRECTION = new Set(['bullish', 'bearish', 'neutral'] as const)

export type NewsRelevance = 'high' | 'medium' | 'low' | 'none'
export type NewsDirection = 'bullish' | 'bearish' | 'neutral'

export interface NewsItem {
  readonly id: string
  readonly source_id: string
  readonly source: string
  readonly url: string
  readonly title: string
  readonly published_at_ms: number | null
  readonly received_at_ms: number
  readonly relevance: NewsRelevance
  readonly relevance_value: number | null
  readonly direction: NewsDirection | null
  readonly license: 'public_rss'
}

export type NewsItemsResponse =
  | { readonly status: 'ok'; readonly items: readonly NewsItem[] }
  | { readonly status: 'off' | 'error'; readonly reason: string }

export interface NewsItems {
  list(limit?: number): NewsItemsResponse
}

export function newsItemsOff(reason: string): NewsItems {
  return {
    list: () => ({ status: 'off', reason }),
  }
}

function relevanceOf(value: unknown): NewsRelevance | null {
  return typeof value === 'string' && RELEVANCE.has(value as NewsRelevance)
    ? (value as NewsRelevance)
    : null
}

function directionOf(value: unknown): NewsDirection | null {
  return typeof value === 'string' && DIRECTION.has(value as NewsDirection)
    ? (value as NewsDirection)
    : null
}

export function createNewsItems(options: {
  readonly newsDbPath: string | undefined
}): NewsItems {
  return {
    list(limit = DEFAULT_LIMIT) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        return { status: 'error', reason: 'invalid_limit' }
      const opened = withDb(options.newsDbPath, (db) =>
        db
          .prepare(
            `SELECT i.item_hash, i.source_id, i.source, i.url, i.title,
                    i.published_at, i.received_at,
                    r.question_version, r.chosen AS relevance, r.value AS relevance_value,
                    d.chosen AS direction
               FROM paper_futures_news_items i
               JOIN paper_futures_news_analysis r
                 ON r.item_hash = i.item_hash
                AND r.question_id = 'news_relevance_btc'
                AND r.status = 'done'
               LEFT JOIN paper_futures_news_analysis d
                 ON d.item_hash = i.item_hash
                AND d.question_id = 'news_direction'
                AND d.question_version = r.question_version
                AND d.status = 'done'
              ORDER BY COALESCE(i.published_at, i.received_at) DESC,
                       i.item_id DESC,
                       r.question_version DESC
              LIMIT ?`,
          )
          .all(limit * 2)
          .map((row) => rowOf(row)),
      )
      if (opened.state !== 'read')
        return { status: 'off', reason: opened.detail }
      const items: NewsItem[] = []
      const seen = new Set<string>()
      for (const row of opened.value as Row[]) {
        const id = typeof row.item_hash === 'string' ? row.item_hash : null
        const relevance = relevanceOf(row.relevance)
        const received = num(row.received_at)
        if (!id || seen.has(id) || !relevance || received === null) continue
        seen.add(id)
        items.push({
          id,
          source_id: String(row.source_id ?? ''),
          source: String(row.source ?? ''),
          url: String(row.url ?? ''),
          title: String(row.title ?? ''),
          published_at_ms: num(row.published_at),
          received_at_ms: received,
          relevance,
          relevance_value: num(row.relevance_value),
          direction: directionOf(row.direction),
          license: 'public_rss',
        })
        if (items.length >= limit) break
      }
      return { status: 'ok', items }
    },
  }
}
