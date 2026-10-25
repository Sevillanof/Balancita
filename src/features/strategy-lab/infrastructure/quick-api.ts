import { STRATEGIES_API_BASE } from './strategy-api.ts'

/**
 * Qwen's quick test: a small sample of the photos of the past, to filter a change of prompt or model before the full
 * run. Orientative only: it is not the exam and approves nothing. The server writes; this client asks and reads.
 */
/**
 * One voting line of the sheet (F1, F2, F3, F4, F6, F7): how much Qwen votes on it and how much of that comes from the numbers
 * (factors variants only). Voting and reading are different things. The fields after `flip_n` are missing in the summaries
 * saved before version 6, so the screen reads them as «sin dato».
 */
export type QuickReading = {
  id: string
  label: string
  /** What the gradient is measured against («z de 24 h»…). */
  number: string
  /** Share (0–1) of the photos with mirror where |real gradient| ≥ 0,25, over `vote_n` photos (F4: only photos outside the area). */
  vote_share?: number | null
  vote_n?: number
  /** Among the photos where it voted, share (0–1) where the sign flips in the mirror, over `flip_n` photos. */
  flip_share: number | null
  flip_n: number
  /** Mean of (real + mirror) / 2: the bias that does not depend on the data (−2…+2). */
  habit?: number | null
  /** Spearman between Qwen's real gradient and the number of the line, over `corr_n` photos. */
  corr: number | null
  corr_n: number
  verdict: 'no vota' | 'lee' | 'sesgado' | 'a medias' | 'no lee' | 'sin dato'
}

/** The same photos: Qwen's sum and the rule without Qwen against the move, and always long / always short. */
export type QuickComparisonRow = {
  horizon_min: number
  photos: number
  qwen_spearman: number | null
  rule_spearman: number | null
  always_long_net_bp: number | null
  always_short_net_bp: number | null
}

export type QuickFicha = {
  photos: number
  readings: QuickReading[]
  reads: number
  comparison: QuickComparisonRow[]
}

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
  /** Only the variants with the 8-factor sheet (`kind` `factors`). */
  ficha?: QuickFicha
}

/** One candidate of the quick test (another prompt or another model) with its last state; the finished ones are compared. */
export type QuickVariant = {
  id: string
  label: string
  kind: 'control' | 'prompt' | 'state' | 'factors' | 'model'
  note?: string | null
  /** Size of the model to have on the Mac, for the model variants. */
  approx_gb?: number | null
  state: 'none' | 'running' | 'done' | 'failed'
  summary?: QuickSummary | null
  error?: string | null
  started_ms?: number | null
}

export type QuickState = {
  /** The variant this state belongs to: the one started last. */
  variant?: string
  variants?: QuickVariant[]
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
  start: (strategyId: string, variant?: string) => Promise<void>
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
  async start(strategyId, variant) {
    const response = await fetch(url(strategyId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(variant ? { variant } : {}),
    })
    if (!response.ok) throw await failure(response)
  },
}
