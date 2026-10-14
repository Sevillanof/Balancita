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

/**
 * Read-only rule: Kronos is shown as "Actividad verificada" only when the
 * summary file of the last cycle is at most 90 minutes old AND the Kronos
 * scores route answers with data. Configuration or a running process alone
 * never count; anything else stays "Estado no verificado".
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
  if (now - updated > KRONOS_MAX_AGE_MS)
    return { verified: false, reason: 'summary_stale' }
  if (scores === null || scores.status !== 'ok')
    return { verified: false, reason: scores?.reason ?? 'scores_off' }
  return {
    verified: true,
    updated_ms: updated,
    trades: finite(row.trades),
    decisions: finite(row.decisions),
  }
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
