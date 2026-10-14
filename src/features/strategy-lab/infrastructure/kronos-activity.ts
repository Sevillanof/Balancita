import { loadKronosScores, type QwenScores } from './qwen-scores.ts'

/** `GET /api/system` through the Vite proxy (the same route the usage chip polls). */
export const SYSTEM_URL = '/api-live/system'
/** Same limit as the observability check B1: the summary is rewritten every 3600 s. */
export const KRONOS_MAX_AGE_MS = 90 * 60 * 1000

export type KronosActivity =
  | {
      verified: true
      updated_ms: number
      trades: number | null
      decisions: number | null
    }
  | { verified: false; reason: string }

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Clock skew tolerated before a timestamp counts as "from the future". */
export const KRONOS_FUTURE_TOLERANCE_MS = 5_000

/**
 * Read-only rule: Kronos is shown as "Actividad reciente registrada" only when
 * the summary file of the last cycle is at most 90 minutes old AND the Kronos
 * scores route carries real evidence (a product with decisions or forward
 * trades, with timestamps). `status: ok` with no products, configuration or a
 * running process never count; future timestamps are rejected. Anything else
 * stays "Estado no verificado".
 */
export function kronosActivity(
  system: unknown,
  scores: QwenScores | null,
  now: number,
): KronosActivity {
  if (system === null || typeof system !== 'object')
    return { verified: false, reason: 'system_unavailable' }
  const kronos = (system as { kronos?: unknown }).kronos
  if (kronos === null || typeof kronos !== 'object')
    return { verified: false, reason: 'no_kronos_summary' }
  const row = kronos as Record<string, unknown>
  const updated = finite(row.updated_ms)
  if (updated === null) return { verified: false, reason: 'updated_ms_null' }
  if (updated > now + KRONOS_FUTURE_TOLERANCE_MS)
    return { verified: false, reason: 'summary_in_future' }
  if (now - updated > KRONOS_MAX_AGE_MS)
    return { verified: false, reason: 'summary_stale' }
  if (scores === null || scores.status !== 'ok')
    return { verified: false, reason: scores?.reason ?? 'scores_off' }
  const evidence = scoresEvidence(scores, now)
  if (evidence !== 'ok') return { verified: false, reason: evidence }
  return {
    verified: true,
    updated_ms: updated,
    trades: finite(row.trades),
    decisions: finite(row.decisions),
  }
}

/** Real, timestamped decisions or forward trades; no future timestamps. */
function scoresEvidence(
  scores: QwenScores,
  now: number,
): 'ok' | 'scores_without_evidence' | 'scores_timestamp_in_future' {
  const limit = now + KRONOS_FUTURE_TOLERANCE_MS
  let evidence = false
  for (const product of Array.isArray(scores.products) ? scores.products : []) {
    const stamps: number[] = []
    let verifiableTrade = false
    let stampedRow = false
    const rows = Array.isArray(product.rows) ? product.rows : []
    const trades = Array.isArray(product.trades) ? product.trades : []
    for (const r of rows) {
      const t = finite(r?.bucket_start)
      if (t !== null) {
        stamps.push(t)
        stampedRow = true
      }
    }
    for (const trade of trades) {
      const entry = finite(trade?.entry_time_ms)
      const exit = finite(trade?.exit_time_ms)
      if (entry !== null) stamps.push(entry)
      if (exit !== null) stamps.push(exit)
      if (entry !== null && exit !== null) verifiableTrade = true
    }
    const open = finite(product.open_position?.entry_time_ms)
    if (open !== null) stamps.push(open)
    if (stamps.some((t) => t > limit)) return 'scores_timestamp_in_future'
    if (stampedRow || verifiableTrade) evidence = true
  }
  return evidence ? 'ok' : 'scores_without_evidence'
}

/**
 * Freshness is a function of the clock, not of when the data was read: the
 * same read stops being "reciente" once 90 minutes pass without a new one.
 */
export function activityAt(
  activity: KronosActivity | null,
  now: number,
): KronosActivity | null {
  if (activity === null || !activity.verified) return activity
  if (activity.updated_ms > now + KRONOS_FUTURE_TOLERANCE_MS)
    return { verified: false, reason: 'summary_in_future' }
  if (now - activity.updated_ms > KRONOS_MAX_AGE_MS)
    return { verified: false, reason: 'summary_stale' }
  return activity
}

export async function loadKronosActivity(
  fetcher: typeof fetch = (...args) => fetch(...args),
  now: () => number = Date.now,
): Promise<KronosActivity> {
  let system: unknown = null
  try {
    const response = await fetcher(SYSTEM_URL)
    if (response.ok) system = await response.json()
  } catch {
    system = null
  }
  const scores = await loadKronosScores(fetcher)
  return kronosActivity(system, scores, now())
}
