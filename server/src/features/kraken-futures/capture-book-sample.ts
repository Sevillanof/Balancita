import type { ExtraMarketFeedOptions } from '../live-gateway/live-capture.ts'

/**
 * How often the capture stores a book snapshot of PF_ETHUSD (operacion-mejoras S1).
 *
 * It was 30 s; a third of the maker shadow's legs ended `sin_datos` because the shadow needs a
 * snapshot at most 20 s before the official leg. 10 s leaves one in range. Same +-0.1 % band,
 * same 100-level cap, no deltas: only the cadence changes, and only for the ETH feed (BTC has no
 * book feed and the other products have no event capture). Disk cost: docs/datos-libro-eth.md.
 */
export const DEFAULT_ETH_BOOK_SAMPLE_MS = 10_000
export const ETH_BOOK_SAMPLE_ENV = 'FUTURES_ETH_BOOK_SAMPLE_MS'
/** The sampler looks at the clock once a second (live-capture `tickMs`): a faster cadence is not possible. */
const MIN_ETH_BOOK_SAMPLE_MS = 1_000

type Env = Readonly<Record<string, string | undefined>>

/** `FUTURES_ETH_BOOK_SAMPLE_MS` (milliseconds); unset, not a number or under 1 s means the default. */
export function ethBookSampleMsFromEnv(env: Env): number {
  const text = env[ETH_BOOK_SAMPLE_ENV]?.trim()
  if (!text) return DEFAULT_ETH_BOOK_SAMPLE_MS
  const value = Number(text)
  return Number.isFinite(value) && value >= MIN_ETH_BOOK_SAMPLE_MS
    ? value
    : DEFAULT_ETH_BOOK_SAMPLE_MS
}

/** The `extraMarketFeed` option of the capture: ETH over its own WebSocket, book snapshot at the configured cadence. */
export function ethExtraMarketFeed(env: Env): ExtraMarketFeedOptions {
  return { productId: 'PF_ETHUSD', bookSampleMs: ethBookSampleMsFromEnv(env) }
}
