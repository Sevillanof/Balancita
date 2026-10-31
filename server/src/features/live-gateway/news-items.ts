import { withDb, num, rowOf, type Row } from './observability-health.ts'
import type { DatabaseSync } from 'node:sqlite'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const RELEVANCE = new Set(['high', 'medium', 'low', 'none'] as const)
const DIRECTION = new Set(['bullish', 'bearish', 'neutral'] as const)

export type NewsRelevance = 'high' | 'medium' | 'low' | 'none'
export type NewsDirection = 'bullish' | 'bearish' | 'neutral'
export type AnalysisStatus = 'pending' | 'partial' | 'done' | 'failed' | 'stale'
export type Eligibility =
  | 'unknown'
  | 'legacy'
  | 'eligible'
  | 'rejected'
  | 'expired'
  | 'used'
  | 'conflict'
  | 'not_selected'

export interface NewsItem {
  readonly id: string
  readonly source_id: string
  readonly source: string
  readonly url: string
  readonly title: string
  readonly published_at_ms: number | null
  readonly received_at_ms: number
  readonly relevance: NewsRelevance | null
  readonly relevance_value: number | null
  readonly direction: NewsDirection | null
  readonly analysis_status: AnalysisStatus
  readonly analysis_version: number | null
  readonly relevance_at_ms: number | null
  readonly direction_at_ms: number | null
  readonly known_at_ms: number | null
  readonly expires_at_ms: number | null
  readonly eligibility: Eligibility
  readonly eligibility_reason: string | null
  readonly license_status: 'unknown' | 'licensed' | 'public_domain'
  readonly license_url: string | null
}

interface Collection {
  readonly status: 'ok' | 'warning' | 'unknown'
  readonly reason: string | null
  readonly failed_sources: readonly string[]
}

export type NewsItemsResponse =
  | {
      readonly status: 'ok'
      readonly items: readonly NewsItem[]
      readonly collection: Collection
      readonly policy: string | null
      readonly checked_at_ms: number
    }
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

function analysisStatus(row: Row): AnalysisStatus {
  if (row.relevance_status === 'failed' || row.direction_status === 'failed')
    return 'failed'
  if (
    row.relevance_status === 'skipped_stale' ||
    row.direction_status === 'skipped_stale'
  )
    return 'stale'
  if (row.relevance_status === 'done' && row.direction_status === 'done')
    return 'done'
  if (row.relevance_status === 'done' || row.direction_status === 'done')
    return 'partial'
  return 'pending'
}

function collectionOf(db: DatabaseSync, now: number): Collection {
  const tables = rowOf(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('paper_futures_news_source_sets','paper_futures_news_polls')",
      )
      .get(),
  )
  if (tables.n !== 2)
    return {
      status: 'unknown',
      reason: 'poll_history_not_recorded',
      failed_sources: [],
    }
  const sources = rowOf(
    db
      .prepare(
        'SELECT source_set_id,sources_json,interval_ms FROM paper_futures_news_source_sets ORDER BY source_set_id DESC LIMIT 1',
      )
      .get(),
  )
  if (typeof sources.sources_json !== 'string')
    return {
      status: 'unknown',
      reason: 'source_configuration_not_recorded',
      failed_sources: [],
    }
  const configured: unknown = JSON.parse(sources.sources_json)
  const interval = num(sources.interval_ms)
  const sourceSetId = num(sources.source_set_id)
  if (
    !Array.isArray(configured) ||
    !configured.length ||
    interval === null ||
    interval <= 0 ||
    sourceSetId === null
  )
    throw new Error('Invalid recorded news-source configuration')
  const failed: string[] = []
  const details: string[] = []
  for (const raw of configured) {
    const source = rowOf(raw)
    if (typeof source.id !== 'string')
      throw new Error('Invalid recorded news source')
    const last = rowOf(
      db
        .prepare(
          'SELECT finished_at_ms,status,detail FROM paper_futures_news_polls WHERE source_set_id=? AND source_id=? ORDER BY poll_id DESC LIMIT 1',
        )
        .get(sourceSetId, source.id),
    )
    const time = num(last.finished_at_ms)
    if (last.status === 'error') {
      failed.push(source.id)
      details.push(`${source.id}: ${String(last.detail ?? 'fetch_error')}`)
    } else if (
      time === null ||
      time > now ||
      now - time > 3 * interval ||
      !['ok', 'not_modified'].includes(String(last.status))
    ) {
      failed.push(source.id)
      details.push(`${source.id}: poll_not_current`)
    }
  }
  return {
    status: failed.length ? 'warning' : 'ok',
    reason: details.length ? details.join('; ') : null,
    failed_sources: failed,
  }
}

function licenseOf(
  lifecycle: Row,
  sourceId: string,
  url: string,
): Pick<NewsItem, 'license_status' | 'license_url'> {
  const info = rowOf(rowOf(lifecycle.source_licenses)[sourceId])
  const unknown = { license_status: 'unknown', license_url: null } as const
  if (
    (info.status !== 'licensed' && info.status !== 'public_domain') ||
    typeof info.url !== 'string' ||
    !info.url.startsWith('https://') ||
    typeof info.host !== 'string'
  )
    return unknown
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return unknown
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !(
      parsed.hostname === info.host || parsed.hostname.endsWith(`.${info.host}`)
    )
  )
    return unknown
  return { license_status: info.status, license_url: info.url }
}

const ELIGIBILITY = new Set<Eligibility>([
  'unknown',
  'legacy',
  'eligible',
  'rejected',
  'expired',
  'used',
  'conflict',
  'not_selected',
])

export function createNewsItems(options: {
  readonly newsDbPath: string | undefined
  readonly liveDbPath?: string
  readonly clock?: () => number
}): NewsItems {
  return {
    list(limit = DEFAULT_LIMIT) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        return { status: 'error', reason: 'invalid_limit' }
      const now = (options.clock ?? Date.now)()
      const opened = withDb(options.newsDbPath, (db) => ({
        collection: collectionOf(db, now),
        rows: db
          .prepare(
            `SELECT i.item_hash, i.source_id, i.source, i.url, i.title,
                    i.published_at, i.received_at,
                    r.question_version, r.chosen AS relevance, r.value AS relevance_value,
                    r.status AS relevance_status, r.analyzed_at AS relevance_at,
                    d.status AS direction_status, d.analyzed_at AS direction_at,
                    d.chosen AS direction
               FROM paper_futures_news_items i
               LEFT JOIN paper_futures_news_analysis r
                 ON r.item_hash = i.item_hash
                AND r.question_id = 'news_relevance_btc'
                AND r.question_version = 2
               LEFT JOIN paper_futures_news_analysis d
                 ON d.item_hash = i.item_hash
                AND d.question_id = 'news_direction'
                AND d.question_version = 2
              ORDER BY COALESCE(i.published_at, i.received_at) DESC,
                       i.item_id DESC
              LIMIT ?`,
          )
          .all(limit)
          .map((row) => rowOf(row)),
      }))
      if (opened.state !== 'read')
        return {
          status: opened.state === 'missing' ? 'off' : 'error',
          reason: opened.detail,
        }
      const owner = withDb(options.liveDbPath, (db) => {
        const row = rowOf(
          db.prepare("SELECT value FROM meta WHERE key='news_lifecycle'").get(),
        )
        return typeof row.value === 'string' ? rowOf(JSON.parse(row.value)) : {}
      })
      const lifecycle = owner.state === 'read' ? owner.value : {}
      const checked = num(lifecycle.checked_at_ms)
      const current =
        checked !== null && checked <= now && now - checked <= 90_000
      const policy =
        current && typeof lifecycle.policy === 'string'
          ? lifecycle.policy
          : null
      const items: NewsItem[] = []
      const seen = new Set<string>()
      for (const row of opened.value.rows) {
        const id = typeof row.item_hash === 'string' ? row.item_hash : null
        const relevance = relevanceOf(row.relevance)
        const received = num(row.received_at)
        if (
          !id ||
          received === null ||
          typeof row.url !== 'string' ||
          !row.url ||
          typeof row.title !== 'string' ||
          !row.title
        )
          return { status: 'error', reason: 'invalid_news_item' }
        if (
          (row.relevance_status === 'done' && !relevance) ||
          (row.direction_status === 'done' && !directionOf(row.direction))
        )
          return { status: 'error', reason: 'invalid_news_analysis' }
        if (seen.has(id))
          return { status: 'error', reason: 'duplicate_news_analysis' }
        seen.add(id)
        const state = analysisStatus(row)
        const published = num(row.published_at)
        const relevanceAt = num(row.relevance_at)
        const directionAt = num(row.direction_at)
        const knownAt =
          state === 'done' && relevanceAt !== null && directionAt !== null
            ? Math.max(received, relevanceAt, directionAt)
            : null
        const permission =
          current && lifecycle.available === true
            ? rowOf(rowOf(lifecycle.items)[id])
            : {}
        const age = num(lifecycle.max_age_ms)
        const basis =
          lifecycle.expiry_basis === 'published_at' ? published : knownAt
        const expires =
          current && age !== null && basis !== null ? basis + age : null
        const eligibility =
          typeof permission.status === 'string' &&
          ELIGIBILITY.has(permission.status as Eligibility)
            ? (permission.status as Eligibility)
            : policy === 'legacy_v1' && lifecycle.available === true
              ? 'legacy'
              : 'unknown'
        items.push({
          id,
          source_id: String(row.source_id ?? ''),
          source: String(row.source ?? ''),
          url: String(row.url ?? ''),
          title: String(row.title ?? ''),
          published_at_ms: published,
          received_at_ms: received,
          relevance: row.relevance_status === 'done' ? relevance : null,
          relevance_value:
            row.relevance_status === 'done' ? num(row.relevance_value) : null,
          direction:
            row.direction_status === 'done' ? directionOf(row.direction) : null,
          analysis_status: state,
          analysis_version: num(row.question_version),
          relevance_at_ms: relevanceAt,
          direction_at_ms: directionAt,
          known_at_ms: knownAt,
          expires_at_ms: num(permission.expires_at_ms) ?? expires,
          eligibility,
          eligibility_reason:
            typeof permission.reason === 'string'
              ? permission.reason
              : owner.state !== 'read'
                ? owner.detail
                : !current
                  ? 'owner_state_not_current'
                  : null,
          ...licenseOf(lifecycle, String(row.source_id ?? ''), row.url),
        })
        if (items.length >= limit) break
      }
      return {
        status: 'ok',
        items,
        collection: opened.value.collection,
        policy,
        checked_at_ms: now,
      }
    },
  }
}
