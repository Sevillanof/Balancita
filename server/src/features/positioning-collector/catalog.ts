import { readFileSync } from 'node:fs'

/**
 * Indicator cards (`config/indicators.json`): the collector downloads and keeps
 * only what an active card declares. A card names the series, the products, the
 * resolution, how much history and who uses it; with no user it cannot be
 * active. An archived card stops updating and its data is deleted
 * `purge_after_days` after `archived_since`.
 */
export type IndicatorCard = Readonly<{
  id: string
  series: 'positioning' | 'premium'
  products: readonly string[]
  resolution: '1h' | '1m'
  /** Start of the history to keep (1h cards). */
  historyFromMs: number | undefined
  /** Days of minute data to keep (1m cards). */
  keepDays: number | undefined
  consumers: readonly { kind: string; id: string }[]
  state: 'active' | 'archived'
  archivedSinceMs: number | undefined
}>

export type IndicatorCatalog = Readonly<{
  purgeAfterDays: number
  cards: readonly IndicatorCard[]
}>

const DAY_MS = 86_400_000
const PRODUCT = /^PF_[A-Z0-9]{2,20}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const CONSUMER_KINDS = ['chart', 'strategy', 'qwen']
const rec = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${what} must be an object.`)
  return value as Record<string, unknown>
}
const date = (value: unknown, what: string): number => {
  if (typeof value !== 'string' || !DATE.test(value))
    throw new TypeError(`${what} must be YYYY-MM-DD.`)
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(ms)) throw new TypeError(`${what} is not a date.`)
  return ms
}

export function parseCatalog(
  text: string,
  pinned: readonly string[],
): IndicatorCatalog {
  const body = rec(JSON.parse(text), 'Catalog')
  if (body.version !== 'indicators.v1')
    throw new TypeError('Unsupported indicator catalog version.')
  const purge = body.purge_after_days
  if (typeof purge !== 'number' || !Number.isInteger(purge) || purge < 1)
    throw new TypeError('purge_after_days must be a positive integer.')
  if (!Array.isArray(body.indicators))
    throw new TypeError('indicators must be a list.')
  const ids = new Set<string>()
  const cards = body.indicators.map((raw: unknown): IndicatorCard => {
    const card = rec(raw, 'Indicator')
    const id = card.id
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id))
      throw new TypeError('Indicator id is invalid.')
    if (ids.has(id)) throw new TypeError(`Duplicate indicator ${id}.`)
    ids.add(id)
    const series = card.series
    if (series !== 'positioning' && series !== 'premium')
      throw new TypeError(`${id}: unknown series.`)
    const resolution = card.resolution
    if (resolution !== '1h' && resolution !== '1m')
      throw new TypeError(`${id}: resolution must be 1h or 1m.`)
    if (series === 'positioning' && resolution !== '1h')
      throw new TypeError(`${id}: positioning is hourly only.`)
    const products =
      card.products === 'pinned'
        ? [...pinned]
        : Array.isArray(card.products)
          ? card.products.map(String)
          : null
    if (!products || products.length === 0)
      throw new TypeError(`${id}: products must be "pinned" or a list.`)
    for (const product of products)
      if (!PRODUCT.test(product) || !pinned.includes(product))
        throw new TypeError(`${id}: ${product} is not a pinned product.`)
    const consumers = (Array.isArray(card.consumers) ? card.consumers : []).map(
      (item: unknown) => {
        const consumer = rec(item, `${id} consumer`)
        if (
          typeof consumer.kind !== 'string' ||
          !CONSUMER_KINDS.includes(consumer.kind) ||
          typeof consumer.id !== 'string' ||
          consumer.id === ''
        )
          throw new TypeError(`${id}: invalid consumer.`)
        return { kind: consumer.kind, id: consumer.id }
      },
    )
    const state = card.state
    if (state !== 'active' && state !== 'archived')
      throw new TypeError(`${id}: state must be active or archived.`)
    if (state === 'active' && consumers.length === 0)
      throw new TypeError(`${id}: an active indicator needs a user.`)
    if (resolution === '1h' && card.history_from === undefined)
      throw new TypeError(`${id}: history_from is required for 1h.`)
    if (resolution === '1m') {
      const keep = card.keep_days
      if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 1)
        throw new TypeError(`${id}: keep_days is required for 1m.`)
    }
    if (state === 'archived' && card.archived_since === undefined)
      throw new TypeError(`${id}: archived needs archived_since.`)
    return {
      id,
      series,
      products,
      resolution,
      historyFromMs:
        card.history_from === undefined
          ? undefined
          : date(card.history_from, `${id} history_from`),
      keepDays: resolution === '1m' ? (card.keep_days as number) : undefined,
      consumers,
      state,
      archivedSinceMs:
        card.archived_since === undefined
          ? undefined
          : date(card.archived_since, `${id} archived_since`),
    }
  })
  return { purgeAfterDays: purge, cards }
}

export function loadCatalog(
  path: string,
  pinned: readonly string[],
): IndicatorCatalog {
  return parseCatalog(readFileSync(path, 'utf8'), pinned)
}

export const DEFAULT_CATALOG_URL = new URL(
  '../../../../config/indicators.json',
  import.meta.url,
)

export type SeriesKind = 'all' | 'top' | 'hour' | 'minute'
export type SeriesPlan = Readonly<{
  productId: string
  kind: SeriesKind
  /** First bucket to keep: history start, or now minus the minute window. */
  fromMs: number
}>

const KINDS = (card: IndicatorCard): SeriesKind[] =>
  card.series === 'positioning'
    ? ['all', 'top']
    : card.resolution === '1h'
      ? ['hour']
      : ['minute']

/** What the collector must fetch and keep now: the union of the active cards. */
export function plan(catalog: IndicatorCatalog, now: number): SeriesPlan[] {
  const wanted = new Map<string, SeriesPlan>()
  for (const card of catalog.cards) {
    if (card.state !== 'active') continue
    const fromMs =
      card.resolution === '1m'
        ? now - (card.keepDays ?? 0) * DAY_MS
        : (card.historyFromMs ?? 0)
    for (const productId of card.products)
      for (const kind of KINDS(card)) {
        const key = `${productId}/${kind}`
        const existing = wanted.get(key)
        // Two users of one series: one download, the longest history.
        if (!existing || fromMs < existing.fromMs)
          wanted.set(key, { productId, kind, fromMs })
      }
  }
  return [...wanted.values()]
}

/** Series of archived cards past the purge delay that no active card still needs. */
export function expired(
  catalog: IndicatorCatalog,
  now: number,
): { productId: string; kind: SeriesKind }[] {
  const keep = new Set(
    plan(catalog, now).map(({ productId, kind }) => `${productId}/${kind}`),
  )
  const out = new Map<string, { productId: string; kind: SeriesKind }>()
  for (const card of catalog.cards) {
    if (
      card.state !== 'archived' ||
      card.archivedSinceMs === undefined ||
      card.archivedSinceMs + catalog.purgeAfterDays * DAY_MS > now
    )
      continue
    for (const productId of card.products)
      for (const kind of KINDS(card)) {
        const key = `${productId}/${kind}`
        if (!keep.has(key)) out.set(key, { productId, kind })
      }
  }
  return [...out.values()]
}
