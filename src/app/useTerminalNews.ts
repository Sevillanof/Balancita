import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'

const POLL_MS = 30_000

export type NewsRelevance = 'high' | 'medium' | 'low' | 'none'
export type NewsDirection = 'bullish' | 'bearish' | 'neutral'
export type NewsAnalysisStatus =
  'pending' | 'partial' | 'done' | 'failed' | 'stale'
export type NewsEligibility =
  | 'unknown'
  | 'legacy'
  | 'eligible'
  | 'rejected'
  | 'expired'
  | 'used'
  | 'conflict'
  | 'not_selected'
export type NewsSource =
  | { state: 'loading' }
  | {
      state: 'ok'
      collectorStatus: 'ok' | 'warning' | 'unknown'
      collectorReason: string | null
      policy: string | null
    }
  | { state: 'off' | 'error'; reason: string }

export interface TerminalNewsItem {
  readonly id: string
  readonly source: string
  readonly url: string
  readonly title: string
  readonly publishedAtMs: number | null
  readonly receivedAtMs: number
  readonly relevance: NewsRelevance | null
  readonly relevanceValue: number | null
  readonly direction: NewsDirection | null
  readonly analysisStatus?: NewsAnalysisStatus
  readonly analysisVersion?: number | null
  readonly relevanceAtMs?: number | null
  readonly directionAtMs?: number | null
  readonly knownAtMs?: number | null
  readonly expiresAtMs?: number | null
  readonly eligibility?: NewsEligibility
  readonly eligibilityReason?: string | null
  readonly licenseStatus?: string
  readonly licenseUrl?: string | null
}

export type NewsBriefingStatus =
  'ok' | 'pending' | 'no_news' | 'off' | 'error' | 'stale'

export interface NewsBriefingSource {
  readonly id: string
  readonly source: string
  readonly url: string
  readonly publishedAtMs: number | null
  readonly receivedAtMs: number
  readonly licenseStatus: string
}

export interface TerminalNewsBriefing {
  readonly status: NewsBriefingStatus
  readonly product: string
  readonly text: string | null
  readonly knownAtMs: number | null
  readonly checkedAtMs: number
  readonly expiresAtMs: number | null
  readonly sourceCount: number
  readonly sources: readonly NewsBriefingSource[]
  readonly reason: string | null
  readonly inputHash?: string | null
  readonly modelRef?: string | null
}

const RELEVANCE = new Set<NewsRelevance>(['high', 'medium', 'low', 'none'])
const DIRECTION = new Set<NewsDirection>(['bullish', 'bearish', 'neutral'])
const ANALYSIS = new Set<NewsAnalysisStatus>([
  'pending',
  'partial',
  'done',
  'failed',
  'stale',
])
const ELIGIBILITY = new Set<NewsEligibility>([
  'unknown',
  'legacy',
  'eligible',
  'rejected',
  'expired',
  'used',
  'conflict',
  'not_selected',
])

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function briefingStatus(value: unknown): value is NewsBriefingStatus {
  return (
    value === 'ok' ||
    value === 'pending' ||
    value === 'no_news' ||
    value === 'off' ||
    value === 'error' ||
    value === 'stale'
  )
}

export function decodeNewsBriefing(
  payload: unknown,
): TerminalNewsBriefing | null {
  const value = record(payload).briefing
  if (value === undefined || value === null) return null
  const row = record(value)
  const knownAtMs = num(row.known_at_ms)
  const checkedAtMs = num(row.checked_at_ms)
  const text = typeof row.text === 'string' ? row.text.trim() : null
  if (
    !briefingStatus(row.status) ||
    row.product !== 'PF_ETHUSD' ||
    checkedAtMs === null ||
    !Number.isInteger(row.source_count) ||
    !Array.isArray(row.sources) ||
    row.source_count !== row.sources.length ||
    (knownAtMs !== null && knownAtMs > checkedAtMs) ||
    (text !== null && text.length > 200) ||
    (row.status === 'ok' &&
      (!text || knownAtMs === null || row.sources.length === 0))
  )
    throw new Error('Invalid news briefing response')
  const sources = row.sources.map((value): NewsBriefingSource => {
    const source = record(value)
    const receivedAtMs = num(source.received_at_ms)
    if (
      typeof source.id !== 'string' ||
      typeof source.source !== 'string' ||
      typeof source.url !== 'string' ||
      typeof source.license_status !== 'string' ||
      receivedAtMs === null
    )
      throw new Error('Invalid news briefing provenance')
    return {
      id: source.id,
      source: source.source,
      url: source.url,
      publishedAtMs: num(source.published_at_ms),
      receivedAtMs,
      licenseStatus: source.license_status,
    }
  })
  return {
    status: row.status,
    product: row.product,
    text,
    knownAtMs,
    checkedAtMs,
    expiresAtMs: num(row.expires_at_ms),
    sourceCount: sources.length,
    sources,
    reason: typeof row.reason === 'string' ? row.reason : null,
    inputHash: typeof row.input_hash === 'string' ? row.input_hash : null,
    modelRef: typeof row.model_ref === 'string' ? row.model_ref : null,
  }
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
    const analysisStatus =
      row.analysis_status === undefined
        ? relevance
          ? 'done'
          : 'pending'
        : typeof row.analysis_status === 'string' &&
            ANALYSIS.has(row.analysis_status as NewsAnalysisStatus)
          ? (row.analysis_status as NewsAnalysisStatus)
          : null
    if (
      !id ||
      !title ||
      !url ||
      receivedAtMs === null ||
      !analysisStatus ||
      (row.relevance !== null && row.relevance !== undefined && !relevance)
    )
      return []
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
        analysisStatus,
        analysisVersion: num(row.analysis_version),
        relevanceAtMs: num(row.relevance_at_ms),
        directionAtMs: num(row.direction_at_ms),
        knownAtMs: num(row.known_at_ms),
        expiresAtMs: num(row.expires_at_ms),
        eligibility:
          typeof row.eligibility === 'string' &&
          ELIGIBILITY.has(row.eligibility as NewsEligibility)
            ? (row.eligibility as NewsEligibility)
            : 'unknown',
        eligibilityReason:
          typeof row.eligibility_reason === 'string'
            ? row.eligibility_reason
            : null,
        licenseStatus:
          typeof row.license_status === 'string'
            ? row.license_status
            : 'unknown',
        licenseUrl:
          typeof row.license_url === 'string' ? row.license_url : null,
      },
    ]
  })
}

const EMPTY: TerminalNewsItem[] = []

export function useTerminalNews(
  apiBase = '/api-live',
  enabled = true,
): {
  items: TerminalNewsItem[]
  loaded: boolean
  source: NewsSource
  briefing: TerminalNewsBriefing | null
} {
  const [read, setRead] = useState<{
    base: string
    items: TerminalNewsItem[]
    source: NewsSource
    briefing: TerminalNewsBriefing | null
  } | null>(null)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/news?limit=200`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = record(await response.json())
        if (controller.signal.aborted) return
        if (body.status === 'off' || body.status === 'error') {
          setRead((previous) => ({
            base: apiBase,
            items: previous?.base === apiBase ? previous.items : EMPTY,
            briefing: previous?.base === apiBase ? previous.briefing : null,
            source: {
              state: body.status === 'off' ? 'off' : 'error',
              reason: String(body.reason ?? 'News unavailable'),
            },
          }))
          return
        }
        const items = decodeTerminalNews(body)
        if (
          body.status !== 'ok' ||
          !Array.isArray(body.items) ||
          items.length !== body.items.length
        )
          throw new Error('Invalid news response')
        const collection = record(body.collection)
        setRead({
          base: apiBase,
          items,
          briefing: decodeNewsBriefing(body),
          source: {
            state: 'ok',
            collectorStatus:
              collection.status === 'ok' || collection.status === 'warning'
                ? collection.status
                : 'unknown',
            collectorReason:
              typeof collection.reason === 'string' ? collection.reason : null,
            policy: typeof body.policy === 'string' ? body.policy : null,
          },
        })
      } catch (error) {
        if (!controller.signal.aborted)
          setRead((previous) => ({
            base: apiBase,
            items: previous?.base === apiBase ? previous.items : EMPTY,
            briefing: previous?.base === apiBase ? previous.briefing : null,
            source: {
              state: 'error',
              reason: error instanceof Error ? error.message : String(error),
            },
          }))
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [apiBase, enabled])

  if (!enabled)
    return {
      items: EMPTY,
      loaded: false,
      source: { state: 'off', reason: 'News disabled in this mode' },
      briefing: null,
    }
  return read?.base === apiBase
    ? {
        items: read.items,
        loaded: true,
        source: read.source,
        briefing: read.briefing,
      }
    : {
        items: EMPTY,
        loaded: false,
        source: { state: 'loading' },
        briefing: null,
      }
}
