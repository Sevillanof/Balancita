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

/** One row of the operation table (version 8): operations closed by the fixed exit rule, net after costs. */
export type QuickOperationStats = {
  n: number
  neto_bp: number | null
  ganadoras: number | null
  ic: [number | null, number | null]
  total_bp: number | null
  por_vuelta: number
  por_tiempo: number
  horas: number | null
}

/**
 * How the version 8 operator would have done on the photos (the short sheet only): each entry Qwen makes, closed when the
 * maestro turns against it or at the time limit, against the formulas alone on the same photos.
 */
export type QuickOperation = {
  fotos: number
  max_horas: number
  salida: string
  qwen: QuickOperationStats & {
    con_maestro: number | null
    con_portero: number | null
    vs_azar_pct: number | null
  }
  qwen_todas: QuickOperationStats
  formula: QuickOperationStats
  maestro_fuerte: QuickOperationStats
  siempre_largo: QuickOperationStats
  siempre_corto: QuickOperationStats
  espejo_bloqueo: number
  espera: number
  /** Notional of each operation in USD, and the operations by time: for the charts (absent in older summaries). */
  nocional_usd?: number
  curvas?: Record<'qwen' | 'formula' | 'maestro_fuerte', QuickTrade[]>
  signals: {
    gana: boolean | null
    ic_positivo: boolean | null
    azar: boolean | null
    mejor_que_formula: boolean | null
  }
}

/** One operation of the screen's charts: product, side (1 long, −1 short), entry and exit, net bp after costs, why it closed. */
export type QuickTrade = {
  producto: string
  lado: 1 | -1
  entrada_ms: number
  salida_ms: number
  neto_bp: number
  motivo: string
}

/** The formula alone (no Qwen) over every wake of the exam range, one position per product, as it operates live. */
export type QuickFormula = {
  fotos: number
  desde_ms: number
  hasta_ms: number
  max_horas: number
  nocional_usd: number
  productos: string[]
  formula: QuickOperationStats
  maestro_fuerte: QuickOperationStats
  siempre_largo: QuickOperationStats
  siempre_corto: QuickOperationStats
  curvas: Record<
    'formula' | 'maestro_fuerte' | 'siempre_largo' | 'siempre_corto',
    QuickTrade[]
  >
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
  /** Only the short sheet (Qwen en vivo version 8): the operation as the live operator runs it. */
  operacion?: QuickOperation
  /** Only the formula-only variant (no Qwen). */
  formula?: QuickFormula
}

/** One candidate of the quick test (another prompt or another model) with its last state; the finished ones are compared. */
export type QuickVariant = {
  id: string
  label: string
  kind: 'control' | 'prompt' | 'state' | 'factors' | 'model' | 'formula'
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
