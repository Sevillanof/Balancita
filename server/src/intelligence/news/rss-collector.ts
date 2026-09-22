import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { SupportedInstrumentId, TimestampMs } from '../contracts.ts'
import type { NewsCollector } from '../contracts.ts'

export interface RssSourceConfig {
  readonly sourceId: string
  readonly source: string
  readonly feedUrl: string
  readonly documentationUrl: string
  readonly licenseUrl: string
  readonly sourceLevel: 'official_primary' | 'licensed_reporting'
  readonly licenseStatus: 'official_public' | 'licensed' | 'unknown'
}

export const OFFICIAL_RSS_SOURCES = {
  sec: {
    sourceId: 'sec',
    source: 'SEC',
    feedUrl: 'https://www.sec.gov/news/pressreleases.rss',
    documentationUrl: 'https://www.sec.gov/about/rss-feeds',
    licenseUrl: 'https://www.sec.gov/about/developer-resources',
    sourceLevel: 'official_primary',
    licenseStatus: 'official_public',
  },
  ecb: {
    sourceId: 'ecb',
    source: 'European Central Bank',
    feedUrl: 'https://www.ecb.europa.eu/rss/press.html',
    documentationUrl: 'https://www.ecb.europa.eu/home/html/rss.en.html',
    licenseUrl:
      'https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html',
    sourceLevel: 'official_primary',
    licenseStatus: 'official_public',
  },
  fed: {
    sourceId: 'fed',
    source: 'Federal Reserve Board',
    feedUrl: 'https://www.federalreserve.gov/feeds/press_all.xml',
    documentationUrl: 'https://www.federalreserve.gov/feeds/feeds.htm',
    licenseUrl: 'https://www.federalreserve.gov/disclaimer.htm',
    sourceLevel: 'official_primary',
    licenseStatus: 'official_public',
  },
} as const satisfies Readonly<Record<string, RssSourceConfig>>

export interface RssNewsItem {
  readonly sourceId: string
  readonly source: string
  readonly feedUrl: string
  readonly sourceItemId: string
  readonly title: string
  readonly link: string
  readonly publishedAt?: string
  readonly description?: string
  readonly author?: string
  readonly category?: string
  readonly sourceSummary?: string
  readonly important?: boolean
  readonly tradeIntent?: 'buy' | 'sell' | 'neutral'
  readonly retrievedAt?: TimestampMs
}

export interface NewsHttpRequestInit {
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

export interface NewsHttpResponse {
  readonly status: number
  readonly body: string
}

export type NewsHttpFetcher = (
  url: string,
  init: NewsHttpRequestInit,
) => Promise<NewsHttpResponse>

export interface RssNewsCollectorOptions {
  readonly source: RssSourceConfig
  readonly userAgent: string
  readonly fetcher?: NewsHttpFetcher
  readonly timeoutMs?: number
  readonly clock?: () => number
}

export class RssNewsCollector implements NewsCollector<RssNewsItem> {
  readonly domain = 'news' as const
  readonly source: string
  private readonly sourceConfig: RssSourceConfig
  private readonly userAgent: string
  private readonly fetcher: NewsHttpFetcher
  private readonly timeoutMs: number
  private readonly clock: () => number

  constructor(options: RssNewsCollectorOptions) {
    if (options.userAgent.trim() === '')
      throw new Error('RSS collector user-agent is required.')
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0)
      throw new Error('RSS collector timeout must be positive.')
    this.sourceConfig = options.source
    this.source = options.source.sourceId
    this.userAgent = options.userAgent
    this.fetcher = options.fetcher ?? defaultFetcher
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.clock = options.clock ?? Date.now
  }

  collect(
    instrumentId: SupportedInstrumentId,
    signal?: AbortSignal,
  ): Promise<readonly RssNewsItem[]> {
    return this.collectOnce(instrumentId, signal)
  }

  async collectOnce(
    instrumentId: SupportedInstrumentId = 'BTC-EUR',
    signal?: AbortSignal,
  ): Promise<readonly RssNewsItem[]> {
    if (instrumentId !== 'BTC-EUR')
      throw new Error('RSS news collection only supports BTC-EUR.')

    const controller = new AbortController()
    let timedOut = false
    const forwardAbort = (): void => {
      controller.abort(signal?.reason)
    }
    if (signal?.aborted) forwardAbort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      const response = await this.fetcher(this.sourceConfig.feedUrl, {
        headers: {
          accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml',
          'user-agent': this.userAgent,
        },
        signal: controller.signal,
      })
      if (response.status < 200 || response.status >= 300)
        throw new Error(`RSS request failed with HTTP ${response.status}.`)
      const retrievedAt = this.clock() as TimestampMs
      return parseRssItems(response.body, this.sourceConfig).map((item) => ({
        ...item,
        retrievedAt,
      }))
    } catch (error) {
      if (timedOut)
        throw new Error(`RSS request timed out after ${this.timeoutMs}ms.`, {
          cause: error,
        })
      if (error instanceof Error)
        throw new Error(error.message, { cause: error })
      throw new Error(String(error), { cause: error })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  trimValues: true,
  processEntities: {
    enabled: true,
    maxEntitySize: 10_000,
    maxExpansionDepth: 20,
    maxTotalExpansions: 1_000,
    maxExpandedLength: 100_000,
    maxEntityCount: 1_000,
  },
})

function parseRssItems(
  xml: string,
  source: RssSourceConfig,
): readonly RssNewsItem[] {
  const validation = XMLValidator.validate(xml)
  if (validation !== true) throw new Error('RSS response contains invalid XML.')
  let document: unknown
  try {
    document = parser.parse(xml) as unknown
  } catch {
    throw new Error('RSS response contains invalid XML.')
  }

  const root = asRecord(document)
  const rss = asRecord(root?.rss)
  const channel = asRecord(rss?.channel)
  const feed = asRecord(root?.feed)
  const rawItems = channel?.item ?? feed?.entry
  const items = asArray(rawItems)
  const deduplicated = new Map<string, RssNewsItem>()
  for (const rawItem of items) {
    const item = asRecord(rawItem)
    if (item === undefined) continue
    const rawLink = linkValue(item.link)
    const link =
      rawLink === undefined ? undefined : resolveLink(rawLink, source.feedUrl)
    const sourceItemId =
      textValue(item.guid) ?? textValue(item.id) ?? link ?? ''
    const parsed: RssNewsItem = {
      sourceId: source.sourceId,
      source: source.source,
      feedUrl: source.feedUrl,
      sourceItemId,
      title: textValue(item.title) ?? '',
      link: link ?? '',
      ...((dateValue(item.pubDate) ??
      dateValue(item.published) ??
      dateValue(item.updated))
        ? {
            publishedAt:
              dateValue(item.pubDate) ??
              dateValue(item.published) ??
              dateValue(item.updated),
          }
        : {}),
      ...((textValue(item.description) ??
      textValue(item.summary) ??
      textValue(item.content))
        ? {
            description:
              textValue(item.description) ??
              textValue(item.summary) ??
              textValue(item.content),
          }
        : {}),
      ...(textValue(item.creator) ? { author: textValue(item.creator) } : {}),
      ...(categoryValue(item.category)
        ? { category: categoryValue(item.category) }
        : {}),
    }
    const identity =
      sourceItemId || link || `${parsed.title}:${parsed.publishedAt ?? ''}`
    deduplicated.set(identity, parsed)
  }
  return [...deduplicated.values()]
}

async function defaultFetcher(
  url: string,
  init: NewsHttpRequestInit,
): Promise<NewsHttpResponse> {
  const response = await fetch(url, {
    headers: init.headers,
    signal: init.signal,
  })
  return { status: response.status, body: await response.text() }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): readonly unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number')
    return String(value).trim()
  const record = asRecord(value)
  if (record === undefined) return undefined
  const text = record['#text']
  return typeof text === 'string' || typeof text === 'number'
    ? String(text).trim()
    : undefined
}

function linkValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim()
  const links = asArray(value)
  const candidates = links
    .map(asRecord)
    .filter((link): link is Record<string, unknown> => link !== undefined)
  const alternate = candidates.find((link) => link['@_rel'] === 'alternate')
  return textValue(alternate?.['@_href'] ?? candidates[0]?.['@_href'])
}

function categoryValue(value: unknown): string | undefined {
  const category = asArray(value)[0]
  const record = asRecord(category)
  return textValue(record?.['@_term'] ?? category)
}

function resolveLink(value: string, base: string): string {
  try {
    return new URL(value, base).href
  } catch {
    return value
  }
}

function dateValue(value: unknown): string | undefined {
  return textValue(value)
}
