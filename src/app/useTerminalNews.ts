import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'

const POLL_MS = 30_000

export type NewsRelevance = 'high' | 'medium' | 'low' | 'none'
export type NewsDirection = 'bullish' | 'bearish' | 'neutral'

export interface TerminalNewsItem {
  readonly id: string
  readonly source: string
  readonly url: string
  readonly title: string
  readonly publishedAtMs: number | null
  readonly receivedAtMs: number
  readonly relevance: NewsRelevance
  readonly relevanceValue: number | null
  readonly direction: NewsDirection | null
}

const RELEVANCE = new Set<NewsRelevance>(['high', 'medium', 'low', 'none'])
const DIRECTION = new Set<NewsDirection>(['bullish', 'bearish', 'neutral'])

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function decodeTerminalNews(payload: unknown): TerminalNewsItem[] {
  const body = record(payload)
  if (body.status !== 'ok' || !Array.isArray(body.items)) return []
  return body.items.map(record).flatMap((row) => {
    const id = typeof row.id === 'string' ? row.id : null
    const title = typeof row.title === 'string' ? row.title : null
    const url = typeof row.url === 'string' ? row.url : null
    const source = typeof row.source === 'string' ? row.source : ''
    const receivedAtMs = num(row.received_at_ms)
    const relevance =
      typeof row.relevance === 'string' &&
      RELEVANCE.has(row.relevance as NewsRelevance)
        ? (row.relevance as NewsRelevance)
        : null
    if (!id || !title || !url || receivedAtMs === null || !relevance) return []
    const direction =
      typeof row.direction === 'string' &&
      DIRECTION.has(row.direction as NewsDirection)
        ? (row.direction as NewsDirection)
        : null
    return [
      {
        id,
        source,
        url,
        title,
        publishedAtMs: num(row.published_at_ms),
        receivedAtMs,
        relevance,
        relevanceValue: num(row.relevance_value),
        direction,
      },
    ]
  })
}

const EMPTY: TerminalNewsItem[] = []

export function useTerminalNews(
  apiBase = '/api-live',
  enabled = true,
): { items: TerminalNewsItem[]; loaded: boolean } {
  const [items, setItems] = useState<TerminalNewsItem[]>(EMPTY)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = () => {
      fetch(`${apiBase}/news?limit=200`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (cancelled) return
          if (data) setItems(decodeTerminalNews(data))
          setLoaded(true)
        })
        .catch(() => {
          if (!cancelled) setLoaded(true)
        })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [apiBase, enabled])

  return enabled ? { items, loaded } : { items: EMPTY, loaded: false }
}
