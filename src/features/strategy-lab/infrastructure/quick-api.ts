import { STRATEGIES_API_BASE } from './strategy-api.ts'

/**
 * Qwen's quick test: a small sample of the photos of the past, to filter a change of prompt or model before the full
 * run. Orientative only: it is not the exam and approves nothing. The server writes; this client asks and reads.
 */
export type QuickSummary = {
  photos: number
  horizon_min: number
  spearman: number | null
  spearman_ci: [number | null, number | null]
  extremes_net_bp: number | null
  extremes_ci: [number | null, number | null]
  vs_random_pct: number | null
  signals: {
    extremes: boolean | null
    random: boolean | null
    spearman: boolean | null
  }
  note: string
}

export type QuickState = {
  state: 'none' | 'running' | 'done' | 'failed'
  answered?: number
  total?: number
  /** `fotos` while the photos are made, `preguntando` once Qwen is asked. */
  phase?: string
  started_ms?: number
  asking_ms?: number
  updated_ms?: number
  /** Set by the screen when it read this state (the browser clock). */
  fetched_ms?: number
  summary?: QuickSummary | null
  error?: string | null
  snapshots: number
  note: string
}

export type QuickApi = {
  status: (strategyId: string) => Promise<QuickState>
  start: (strategyId: string) => Promise<void>
}

async function failure(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { detail?: string }
    if (body.detail) return new Error(body.detail)
  } catch {
    /* no JSON body */
  }
  return new Error(`El registro respondió ${response.status}.`)
}

const url = (strategyId: string) =>
  `${STRATEGIES_API_BASE}/strategies/${encodeURIComponent(strategyId)}/quick`

export const quickApi: QuickApi = {
  async status(strategyId) {
    const response = await fetch(url(strategyId))
    if (!response.ok) throw await failure(response)
    return (await response.json()) as QuickState
  },
  async start(strategyId) {
    const response = await fetch(url(strategyId), { method: 'POST' })
    if (!response.ok) throw await failure(response)
  },
}
