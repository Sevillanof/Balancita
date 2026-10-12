import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { BookReconstructor } from './book.ts'
import { BookStore } from './store.ts'

export const FUTURES_WS_URL = 'wss://futures.kraken.com/ws/v1'

export interface BookSocket {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(message: string): void
  close(): void
}

export interface CollectorOptions {
  readonly store: BookStore
  readonly products: readonly string[]
  readonly makeSocket: (url: string) => BookSocket
  readonly url?: string
  /** One stored depth row per product every this many ms. */
  readonly snapshotMs?: number
  /** No message for this long on a live socket: log a gap and reconnect. */
  readonly staleMs?: number
  readonly maxDays?: number
  readonly maxBytes?: number
  readonly minFreeBytes?: number
  readonly now?: () => number
  readonly log?: (line: string) => void
  /** Called once when the collector stops itself (low disk). */
  readonly onStop?: (reason: string) => void
}

/**
 * Independent public order-book collector: own database, own lock (taken by
 * the caller), no credentials. Rebuilds each book in memory from the feed,
 * stores bounded depth statistics, and logs every interruption as a gap.
 */
export class OrderBookCollector {
  private readonly o: Required<Omit<CollectorOptions, 'onStop'>> & {
    onStop?: (reason: string) => void
  }
  private readonly books = new Map<string, BookReconstructor>()
  private readonly lastGood = new Map<string, number>()
  private socket: BookSocket | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = true
  private lastMessageAt = 0
  private messages = 0
  private windowMessages = 0
  private windowStart = 0
  private readonly applyMs: number[] = []

  constructor(options: CollectorOptions) {
    this.o = {
      url: FUTURES_WS_URL,
      snapshotMs: 5_000,
      staleMs: 15_000,
      maxDays: 14,
      maxBytes: 400 * 1_048_576,
      minFreeBytes: 5 * 1_073_741_824,
      now: Date.now,
      log: (line) => console.log(line),
      ...options,
    }
    for (const product of options.products)
      this.books.set(product, new BookReconstructor(product))
  }

  get totalMessages() {
    return this.messages
  }

  start() {
    const now = this.o.now()
    const { previousStopped } = this.o.store.startRun(now)
    this.o.log(
      `[book] start; previous activity ${previousStopped === null ? 'none' : new Date(previousStopped).toISOString()}`,
    )
    this.stopped = false
    this.windowStart = now
    this.connect()
    this.timers.push(setInterval(() => this.snapshotNow(), this.o.snapshotMs))
    this.timers.push(setInterval(() => this.tick(), 5_000))
    this.timers.push(setInterval(() => this.housekeeping(), 60_000))
  }

  stop(reason: string) {
    if (this.stopped) return
    this.stopped = true
    for (const t of this.timers.splice(0)) clearInterval(t)
    if (this.reconnect) clearTimeout(this.reconnect)
    const now = this.o.now()
    for (const [product, last] of this.lastGood)
      this.o.store.gap(product, last, now, `stopped: ${reason}`)
    this.o.store.stopRun(now, reason)
    this.socket?.close()
    this.socket = null
    this.o.log(`[book] stopped: ${reason}`)
  }

  private connect() {
    if (this.stopped) return
    const socket = this.o.makeSocket(this.o.url)
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.lastMessageAt = this.o.now()
      this.subscribe()
    }
    socket.onmessage = (event) => this.handleRaw(event.data)
    const lost = () => {
      if (this.socket !== socket) return
      this.disconnected('socket closed or errored')
    }
    socket.onerror = lost
    socket.onclose = lost
  }

  private subscribe() {
    this.socket?.send(
      JSON.stringify({
        event: 'subscribe',
        feed: 'book',
        product_ids: [...this.books.keys()],
      }),
    )
  }

  private disconnected(reason: string) {
    const now = this.o.now()
    for (const [product, book] of this.books) {
      if (book.synced || this.lastGood.has(product))
        this.gapFor(product, now, reason)
      book.reset()
    }
    const old = this.socket
    this.socket = null
    try {
      old?.close()
    } catch {
      // Already closed.
    }
    if (this.stopped) return
    this.attempt += 1
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6))
    this.reconnect = setTimeout(() => this.connect(), delay)
  }

  private gapFor(product: string, to: number, reason: string) {
    const from = this.lastGood.get(product)
    if (from === undefined) return
    this.o.store.gap(product, from, to, reason)
    this.lastGood.delete(product)
  }

  handleRaw(data: unknown) {
    const t0 = performance.now()
    let message: Record<string, unknown>
    try {
      message = JSON.parse(
        typeof data === 'string' ? data : String(data),
      ) as Record<string, unknown>
    } catch {
      return
    }
    this.handle(message)
    const ms = performance.now() - t0
    if (this.applyMs.length < 20_000) this.applyMs.push(ms)
  }

  handle(message: Record<string, unknown>) {
    this.lastMessageAt = this.o.now()
    this.messages += 1
    this.windowMessages += 1
    const product = message.product_id
    if (typeof product !== 'string') return
    const book = this.books.get(product)
    if (!book) return
    const result = book.apply(message)
    if (result.kind === 'snapshot') this.lastGood.set(product, this.o.now())
    else if (result.kind === 'gap') {
      this.gapFor(
        product,
        this.o.now(),
        `sequence gap: expected ${result.expected}, got ${result.actual}`,
      )
      this.resubscribe(product)
    } else if (result.kind === 'invalid') {
      this.gapFor(product, this.o.now(), `invalid message: ${result.reason}`)
      book.reset()
      this.resubscribe(product)
    }
  }

  private resubscribe(product: string) {
    try {
      this.socket?.send(
        JSON.stringify({
          event: 'unsubscribe',
          feed: 'book',
          product_ids: [product],
        }),
      )
      this.socket?.send(
        JSON.stringify({
          event: 'subscribe',
          feed: 'book',
          product_ids: [product],
        }),
      )
    } catch {
      // The socket is closing; reconnect logic will resubscribe everything.
    }
  }

  snapshotNow() {
    const now = this.o.now()
    for (const [product, book] of this.books) {
      const row = book.depth(now)
      if (row) {
        this.o.store.depth(row)
        this.lastGood.set(product, now)
      }
    }
  }

  private tick() {
    if (this.stopped || !this.socket) return
    if (this.o.now() - this.lastMessageAt > this.o.staleMs)
      this.disconnected('stale: no messages')
  }

  private p99() {
    if (this.applyMs.length === 0) return 0
    const sorted = [...this.applyMs].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length * 0.99)] ?? 0
  }

  housekeeping() {
    const now = this.o.now()
    const seconds = Math.max(1, (now - this.windowStart) / 1000)
    this.o.store.stat(
      now,
      this.messages,
      this.windowMessages / seconds,
      process.memoryUsage().rss / 1_048_576,
      this.p99(),
    )
    this.windowMessages = 0
    this.windowStart = now
    this.applyMs.length = 0
    const removed = this.o.store.enforceLimits(
      now,
      this.o.maxDays,
      this.o.maxBytes,
    )
    if (removed > 0) this.o.log(`[book] limits: ${removed} rows removed`)
    const free = statfsSync(dirname(this.o.store.path))
    if (Number(free.bavail) * Number(free.bsize) < this.o.minFreeBytes) {
      this.stop('low disk space')
      this.o.onStop?.('low disk space')
    }
  }
}
