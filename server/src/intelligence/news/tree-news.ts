import type { TimestampMs } from '../contracts.ts'
import { type RssNewsItem, type RssSourceConfig } from './rss-collector.ts'

export const TREE_NEWS_SOURCE: RssSourceConfig = {
  sourceId: 'tree-news',
  source: 'Tree News',
  feedUrl: 'https://news.treeofalpha.com/',
  documentationUrl: 'https://docs.treeofalpha.com/websockets',
  licenseUrl: 'https://docs.treeofalpha.com/websockets',
  sourceLevel: 'licensed_reporting',
  licenseStatus: 'unknown',
}

export interface TreeNewsSocket {
  onopen: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  close: () => void
}

export type TreeNewsSocketFactory = (url: string) => TreeNewsSocket

export interface TreeNewsServiceOptions {
  readonly enabled: boolean
  readonly url: string
  readonly reconnectMinMs: number
  readonly reconnectMaxMs: number
  readonly socketFactory?: TreeNewsSocketFactory
  readonly setTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>
  readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  readonly clock?: () => TimestampMs
  readonly onItem: (item: RssNewsItem) => void | Promise<void>
  readonly onFailure?: (error: unknown) => void
}

export class TreeNewsService {
  private readonly enabled: boolean
  private readonly url: string
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly socketFactory: TreeNewsSocketFactory
  private readonly schedule: NonNullable<TreeNewsServiceOptions['setTimeout']>
  private readonly cancel: NonNullable<TreeNewsServiceOptions['clearTimeout']>
  private readonly onItem: TreeNewsServiceOptions['onItem']
  private readonly onFailure: (error: unknown) => void
  private readonly clock: () => TimestampMs
  private socket: TreeNewsSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private running = false

  constructor(options: TreeNewsServiceOptions) {
    if (options.reconnectMinMs <= 0 || options.reconnectMaxMs <= 0)
      throw new Error('Tree News reconnect delays must be positive.')
    if (options.reconnectMaxMs < options.reconnectMinMs)
      throw new Error('Tree News maximum reconnect delay must not be smaller.')
    this.enabled = options.enabled
    this.url = options.url
    this.reconnectMinMs = options.reconnectMinMs
    this.reconnectMaxMs = options.reconnectMaxMs
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.schedule =
      options.setTimeout ??
      ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle))
    this.onItem = options.onItem
    this.onFailure = options.onFailure ?? (() => undefined)
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
  }

  start(): void {
    if (!this.enabled || this.running) return
    this.running = true
    this.connect()
  }

  stop(): void {
    this.running = false
    if (this.reconnectTimer !== null) {
      this.cancel(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close()
      } catch (error) {
        this.onFailure(error)
      }
    }
  }

  private connect(): void {
    if (!this.running || this.socket !== null) return
    let socket: TreeNewsSocket
    try {
      socket = this.socketFactory(this.url)
    } catch (error) {
      this.onFailure(error)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.reconnectAttempt = 0
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      const item = parseTreeNewsEvent(event.data)
      if (item === undefined) return
      const received = { ...item, retrievedAt: this.clock() }
      try {
        void Promise.resolve(this.onItem(received)).catch((error: unknown) =>
          this.onFailure(error),
        )
      } catch (error) {
        this.onFailure(error)
      }
    }
    socket.onerror = () => this.disconnect(socket)
    socket.onclose = () => this.disconnect(socket)
  }

  private disconnect(socket: TreeNewsSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch (error) {
      this.onFailure(error)
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) return
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * 2 ** this.reconnectAttempt,
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}

export function parseTreeNewsEvent(input: unknown): RssNewsItem | undefined {
  const parsed = typeof input === 'string' ? parseJson(input) : input
  const root = asRecord(parsed)
  if (root === undefined) return undefined
  const candidates = [root, asRecord(root.data), asRecord(root.news)].filter(
    (value): value is Record<string, unknown> => value !== undefined,
  )
  const item = candidates.find(
    (candidate) =>
      textValue(candidate.title ?? candidate.headline) !== undefined &&
      textValue(candidate.url ?? candidate.link) !== undefined &&
      dateValue(
        candidate.time ??
          candidate.timestamp ??
          candidate.publishedAt ??
          candidate.published_at ??
          candidate.created_at ??
          candidate.rt,
      ) !== undefined,
  )
  if (item === undefined) return undefined

  const title = textValue(item.title ?? item.headline)
  const link = textValue(item.url ?? item.link)
  const publishedAt = dateValue(
    item.time ??
      item.timestamp ??
      item.publishedAt ??
      item.published_at ??
      item.created_at ??
      item.rt,
  )
  if (title === undefined || link === undefined || publishedAt === undefined)
    return undefined
  if (!isHttpsUrl(link)) return undefined

  const sourceItemId =
    textValue(item._id ?? item.id ?? item.event_id ?? item.news_id) ?? link
  const sourceName = textValue(asRecord(item.source)?.name ?? item.source)
  const sourceSummary = textValue(item.summary ?? item.body ?? item.description)
  const importance = importantValue(item.importance ?? item.important)
  const tradeIntent = intentValue(item.intent ?? item.tradeIntent)
  return {
    sourceId: TREE_NEWS_SOURCE.sourceId,
    source: TREE_NEWS_SOURCE.source,
    feedUrl: TREE_NEWS_SOURCE.feedUrl,
    sourceItemId,
    title,
    link,
    publishedAt,
    ...(sourceName === undefined ? {} : { category: sourceName }),
    ...(sourceSummary === undefined ? {} : { sourceSummary }),
    ...(importance === undefined ? {} : { important: importance }),
    ...(tradeIntent === undefined ? {} : { tradeIntent }),
  }
}

function defaultSocketFactory(url: string): TreeNewsSocket {
  return new WebSocket(url) as unknown as TreeNewsSocket
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  return text === '' ? undefined : text
}

function dateValue(value: unknown): string | undefined {
  const text = textValue(value)
  if (text === undefined) return undefined
  const numeric = Number(text)
  const timestamp = Number.isFinite(numeric)
    ? numeric < 1_000_000_000_000
      ? numeric * 1_000
      : numeric
    : Date.parse(text)
  if (!Number.isFinite(timestamp) || timestamp < 0) return undefined
  return new Date(timestamp).toISOString()
}

function importantValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value !== 'string') return undefined
  return /^(?:true|yes|high|important)$/i.test(value.trim())
    ? true
    : /^(?:false|no|low)$/i.test(value.trim())
      ? false
      : undefined
}

function intentValue(value: unknown): 'buy' | 'sell' | 'neutral' | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return normalized === 'buy' ||
    normalized === 'sell' ||
    normalized === 'neutral'
    ? normalized
    : undefined
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
