import type { TerminalEnvelope } from './terminal-stream-client.ts'

/**
 * Longest a pure price tick waits before it reaches the view. The gateway
 * publishes up to four `market.updated` a second; painting each one re-ran
 * the whole terminal (and the chart) and saturated the browser, while a
 * once-a-second repaint is indistinguishable for a paper terminal.
 */
export const MARKET_FLUSH_MS = 1_000

export type TerminalBatcher = {
  push: (event: TerminalEnvelope) => void
  /** Drops what is queued (a snapshot or a resync replaces it). */
  reset: () => void
  dispose: () => void
}

/**
 * Groups stream events into one view update per `intervalMs`. Price ticks are
 * leading-edge: the first one after a quiet period shows at once, the rest
 * coalesce into one trailing flush. Anything else (decisions, orders, fills,
 * positions, account) is rare and flushes immediately, with the ticks queued
 * before it, so order is never changed.
 */
export function createTerminalBatcher(
  flush: (events: TerminalEnvelope[]) => void,
  intervalMs = MARKET_FLUSH_MS,
  now: () => number = Date.now,
): TerminalBatcher {
  let queue: TerminalEnvelope[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFlushAt = Number.NEGATIVE_INFINITY
  const run = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (queue.length === 0) return
    const events = queue
    queue = []
    lastFlushAt = now()
    flush(events)
  }
  return {
    push(event) {
      queue.push(event)
      const wait = lastFlushAt + intervalMs - now()
      if (event.type !== 'market.updated' || wait <= 0) run()
      else timer ??= setTimeout(run, wait)
    },
    reset() {
      queue = []
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
    dispose() {
      this.reset()
    },
  }
}
