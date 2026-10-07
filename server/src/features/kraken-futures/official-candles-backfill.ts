import { OFFICIAL_CANDLES_PER_REQUEST } from './official-candles.ts'
import type { OfficialCandleResponse } from './official-candles.ts'
import type { FuturesMarketStore } from './futures-market-store.ts'

export type BackfillClient = {
  fetch(
    productId: string,
    intervalMs: number,
    fromMs: number,
    toMs: number,
  ): Promise<OfficialCandleResponse>
}

export type BackfillResult = Readonly<{
  requests: number
  inserted: number
  skippedWindows: number
}>

/**
 * Long backfill of official candles for one product and interval over
 * `[fromMs, toMs)`, one charts request per `OFFICIAL_CANDLES_PER_REQUEST`
 * buckets. Resumable: a window whose buckets are all stored is skipped, so a
 * rerun only asks for what is missing, whatever the live capture already wrote.
 * The store keeps the first revision known, so a rerun never rewrites history.
 */
export async function backfillOfficialCandles(options: {
  store: FuturesMarketStore
  client: BackfillClient
  productId: string
  intervalMs: number
  fromMs: number
  toMs: number
  /** Pause between requests (rate limit courtesy). */
  pause?: (ms: number) => Promise<void>
  requestGapMs?: number
  onProgress?: (line: string) => void
}): Promise<BackfillResult> {
  const { store, client, productId, intervalMs, toMs } = options
  const first = Math.ceil(options.fromMs / intervalMs) * intervalMs
  const last = Math.floor(toMs / intervalMs) * intervalMs - intervalMs
  const gap = options.requestGapMs ?? 250
  let requests = 0
  let inserted = 0
  let skippedWindows = 0
  for (
    let start = first;
    start <= last;
    start += OFFICIAL_CANDLES_PER_REQUEST * intervalMs
  ) {
    const end = Math.min(
      start + (OFFICIAL_CANDLES_PER_REQUEST - 1) * intervalMs,
      last,
    )
    const expected = (end - start) / intervalMs + 1
    if (store.countOfficialBuckets(productId, intervalMs, start, end) >= expected) {
      skippedWindows += 1
      continue
    }
    if (requests > 0 && gap > 0)
      await (options.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(gap)
    const response = await client.fetch(productId, intervalMs, start, end + intervalMs)
    requests += 1
    inserted += store.appendOfficialCandles(response).inserted
    options.onProgress?.(
      `${productId} ${intervalMs / 60_000}m ${new Date(start).toISOString()} +${response.candles.length}`,
    )
  }
  return { requests, inserted, skippedWindows }
}
