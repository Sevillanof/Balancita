import { createHash } from 'node:crypto'
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

export interface NewsBriefingSource {
  readonly id: string
  readonly source: string
  readonly url: string
  readonly published_at_ms: number | null
  readonly received_at_ms: number
  readonly license_status: string
}

export interface NewsBriefing {
  readonly status: 'ok' | 'pending' | 'no_news' | 'off' | 'error' | 'stale'
  readonly product: 'PF_ETHUSD'
  readonly text: string | null
  readonly known_at_ms: number | null
  readonly checked_at_ms: number
  readonly source_count: number
  readonly sources: readonly NewsBriefingSource[]
  readonly reason: string | null
  readonly input_hash?: string | null
  readonly model_ref?: string | null
  readonly expires_at_ms?: number
}

export type NewsItemsResponse =
  | {
      readonly status: 'ok'
      readonly items: readonly NewsItem[]
      readonly collection: Collection
      readonly briefing: NewsBriefing
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

const BRIEFING_VERSION = 'futures-news-briefing.v1'
const BRIEFING_TTL_MS = 15 * 60_000
const BRIEFING_WINDOW_MS = 6 * 60 * 60_000
const BRIEFING_STATUSES = new Set(['ok', 'pending', 'no_news', 'off', 'error'])
const HASH = /^[a-f0-9]{64}$/u
const NOT_NEWS =
  /[\p{N}$€£¥%]|https?:\/\/|(?<![\p{L}\p{N}_])(compra\w*|comprar|vend[ae]\w*|vender|opera(?:r|s)?|abre|abrir|cierra|cerrar|entra|entrar|salir|long|short|buy|sell|trade|stop|take.profit|precio\w*|cotiza\w*|cotizaci[oó]n\w*|objetivo\w*|alcista|bajista|bullish|bearish|d[oó]lares?|euros?|usd|eur|dollars?|subir[aá]|bajar[aá]|caer[aá]|alcanzar[aá]|podr[ií]a|podr[aá]|pron[oó]stico\w*|previsi[oó]n\w*|price|forecast|predict\w*|rsi|ema|macd|velas?|candles?|soportes?|resistencias?)(?![\p{L}\p{N}_])|(?:puede|va a|will|may)\s+(?:subir|bajar|caer|recuperar\w*|rise|fall)/iu

function emptyBriefing(
  now: number,
  status: NewsBriefing['status'] = 'pending',
  reason = 'briefing_not_recorded',
): NewsBriefing {
  return {
    status,
    product: 'PF_ETHUSD',
    text: null,
    known_at_ms: null,
    checked_at_ms: now,
    source_count: 0,
    sources: [],
    reason,
    input_hash: null,
    model_ref: null,
  }
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function briefingSources(
  inputs: unknown,
  started: number,
): readonly NewsBriefingSource[] {
  if (!Array.isArray(inputs) || inputs.length > 12)
    throw new Error('invalid inputs')
  const seen = new Set<string>()
  return inputs.map((raw) => {
    const input = rowOf(raw)
    const received = timestamp(input.received_at_ms)
    const published = timestamp(input.published_at_ms)
    const relevanceAt = timestamp(input.relevance_at_ms)
    const directionAt = timestamp(input.direction_at_ms)
    if (
      typeof input.id !== 'string' ||
      !input.id ||
      typeof input.source !== 'string' ||
      !input.source ||
      typeof input.url !== 'string' ||
      !input.url ||
      received === null ||
      received > started ||
      received <= started - BRIEFING_WINDOW_MS ||
      (input.published_at_ms !== null &&
        (published === null ||
          published > started ||
          published <= started - BRIEFING_WINDOW_MS)) ||
      relevanceAt === null ||
      directionAt === null ||
      Math.min(relevanceAt, directionAt) < received ||
      Math.max(relevanceAt, directionAt) > started ||
      !['low', 'medium', 'high'].includes(String(input.relevance)) ||
      !DIRECTION.has(input.direction as NewsDirection) ||
      input.license_status !== 'unknown'
    )
      throw new Error('invalid source provenance')
    const url = new URL(input.url)
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('invalid source URL')
    for (const key of [input.id, input.url]) {
      if (seen.has(key)) throw new Error('duplicate source')
      seen.add(key)
    }
    return {
      id: input.id,
      source: input.source,
      url: input.url,
      published_at_ms: published,
      received_at_ms: received,
      license_status: input.license_status,
    }
  })
}

function briefingOf(db: DatabaseSync, now: number): NewsBriefing {
  try {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_futures_news_briefings'",
        )
        .get()
    )
      return emptyBriefing(now)
    const row = rowOf(
      db
        .prepare(
          `SELECT briefing_version,product,status,started_at_ms,known_at_ms,expires_at_ms,
                  input_hash,inputs_json,model_ref,model_info_json,prompt_hash,prompt_version,text,response_json,reason
             FROM paper_futures_news_briefings
            WHERE briefing_version=? AND product='PF_ETHUSD' AND known_at_ms<=?
            ORDER BY briefing_id DESC LIMIT 1`,
        )
        .get(BRIEFING_VERSION, now),
    )
    if (row.status === undefined) return emptyBriefing(now)
    const started = timestamp(row.started_at_ms)
    const known = timestamp(row.known_at_ms)
    const expires = timestamp(row.expires_at_ms)
    if (
      !BRIEFING_STATUSES.has(String(row.status)) ||
      started === null ||
      known === null ||
      started > known ||
      (row.status !== 'off' && expires === null) ||
      (expires !== null && expires > known + BRIEFING_TTL_MS) ||
      (row.prompt_version !== 1 && row.prompt_version !== 2) ||
      typeof row.prompt_hash !== 'string' ||
      !HASH.test(row.prompt_hash) ||
      typeof row.input_hash !== 'string' ||
      typeof row.inputs_json !== 'string' ||
      createHash('sha256').update(row.inputs_json).digest('hex') !==
        row.input_hash
    )
      throw new Error('invalid briefing identity')
    const sources = briefingSources(JSON.parse(row.inputs_json), started)
    if (
      (['off', 'no_news'].includes(String(row.status)) &&
        sources.length !== 0) ||
      (['ok', 'pending', 'error'].includes(String(row.status)) &&
        sources.length === 0) ||
      (expires !== null &&
        sources.some(
          (source) =>
            expires >
            Math.min(
              source.published_at_ms ?? source.received_at_ms,
              source.received_at_ms,
            ) +
              BRIEFING_WINDOW_MS,
        ))
    )
      throw new Error('invalid briefing freshness')
    if (row.status === 'ok') {
      if (
        typeof row.text !== 'string' ||
        !row.text ||
        row.text.trim() !== row.text ||
        row.text.replace(/\s+/gu, ' ') !== row.text ||
        row.text.normalize('NFKC') !== row.text ||
        // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
        /[<>\r\n\t\u0000-\u001f\u007f]/u.test(row.text) ||
        row.text.length > 200 ||
        row.text.split(/\s+/u).length > 28 ||
        NOT_NEWS.test(row.text) ||
        (
          row.text.match(
            /\b(el|la|los|las|de|del|en|y|sobre|para|con|sin|una?|por|al)\b/giu,
          ) ?? []
        ).length < 2 ||
        typeof row.model_ref !== 'string' ||
        !row.model_ref.toLowerCase().includes('qwen') ||
        typeof row.response_json !== 'string' ||
        typeof row.model_info_json !== 'string'
      )
        throw new Error('invalid summary')
      const response = rowOf(JSON.parse(row.response_json))
      const identity = rowOf(JSON.parse(row.model_info_json))
      const props = rowOf(identity.props)
      const actual = props.model_path ?? props.model_alias ?? row.model_ref
      const choice = rowOf(
        Array.isArray(response.choices) && response.choices.length === 1
          ? response.choices[0]
          : null,
      )
      const message = rowOf(choice.message)
      const summary =
        typeof message.content === 'string'
          ? rowOf(JSON.parse(message.content))
          : {}
      if (
        choice.finish_reason !== 'stop' ||
        Object.keys(summary).length !== 1 ||
        summary.summary !== row.text ||
        identity.model_ref !== row.model_ref ||
        typeof actual !== 'string' ||
        !actual.toLowerCase().includes('qwen') ||
        (response.model !== undefined &&
          (typeof response.model !== 'string' ||
            !response.model.toLowerCase().includes('qwen')))
      )
        throw new Error('summary has no matching Qwen completion')
    }
    const stale =
      ['ok', 'pending', 'no_news'].includes(String(row.status)) &&
      expires !== null &&
      now >= expires
    return {
      status: stale ? 'stale' : (row.status as NewsBriefing['status']),
      product: 'PF_ETHUSD',
      text: row.status === 'ok' && !stale ? String(row.text) : null,
      known_at_ms: row.status === 'pending' ? null : known,
      checked_at_ms: now,
      source_count: sources.length,
      sources,
      reason: stale
        ? 'briefing_expired'
        : typeof row.reason === 'string'
          ? row.reason
          : null,
      input_hash: row.input_hash,
      model_ref: typeof row.model_ref === 'string' ? row.model_ref : null,
      ...(expires === null ? {} : { expires_at_ms: expires }),
    }
  } catch {
    return emptyBriefing(now, 'error', 'invalid_briefing_record')
  }
}

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
        briefing: briefingOf(db, now),
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
        briefing: opened.value.briefing,
        policy,
        checked_at_ms: now,
      }
    },
  }
}
