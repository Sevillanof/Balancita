import { STRATEGIES_API_BASE } from './strategy-api.ts'

/**
 * Strategy gate through the registry S: launch a fixed test, follow its
 * progress, cancel it and download its report. The gate's own process writes
 * `gate.sqlite`; this client only reads and asks.
 */
export type GateKind = 'practice' | 'exam'
export type GateStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type GateVerdict = 'PASA' | 'NO PASA' | 'INCONCLUSO'

/** What the run measured (server-written; absent or `unclassified` on old runs). */
export type GateEvaluationPolicy = {
  classification?: string | null
  account_scope?: string | null
  notional_per_trade_usd?: string | number | null
  qwen_open_decisions_replayed?: boolean | null
  full_policy_validated?: boolean | null
  reasons?: string[] | null
}

/** Observed (provisional) versus definitive result and funding coverage. */
export type GateAccounting = {
  state?: string | null
  reasons?: string[] | null
  closed_trades?: number | null
  open_at_end?: number | null
  observed_net_usd?: number | null
  definitive_net_usd?: number | null
  funding_complete_count?: number | null
  funding_complete_share?: number | null
  minimum_complete_share?: number | null
  funding_eligible?: boolean | null
  funding_time_share?: number | null
}

/** Temporal-stability evidence; `unsupported` is a limitation, not a measured failure. */
export type GateTemporal = {
  state?: string | null
  reasons?: string[] | null
  fold_count?: number | null
  input_trades?: number | null
  used_trades?: number | null
  excluded_trades?: number | null
  training_testing_walk_forward?: boolean | null
}

/** Whether the data and decision evidence of a run can be inspected later. */
export type GateAudit = {
  state?: string | null
  reasons?: string[] | null
  evidence_ready?: boolean | null
  independently_verified?: boolean | null
  full_policy_replay?: boolean | null
}

export type GateRun = {
  id: number
  strategy_id: string
  kind: GateKind
  status: GateStatus
  verdict: GateVerdict | null
  progress: number | null
  phase: string | null
  detail: string | null
  eta_s: number | null
  started_at: number
  finished_at: number | null
  attempts: number | null
  error: string | null
  has_report: boolean
  /** Window and products the run asked for (the server stores them). */
  params?: { from?: string; to?: string; products?: string[] } | null
  /** True when the run is of the strategy's current content (the server marks it). */
  same_version?: boolean
  /** Scope, accounting, temporal and audit evidence: all missing on runs made before they existed. */
  evaluation_policy?: GateEvaluationPolicy | null
  accounting?: GateAccounting | null
  temporal?: GateTemporal | null
  audit?: GateAudit | null
}

export type GateExam =
  | { taken: false }
  | {
      taken: true
      same_version: boolean
      status: string
      verdict: string | null
      date: string
      run_id: number
    }

export type GateOverview = {
  runs: GateRun[]
  exam: GateExam
  running: { id: number; strategy_id: string } | null
  /** Kronos only: its five practice tramos and its exam, cut from its own recorded operation. */
  stages?: {
    practice: { label: string; from: string; to: string }[]
    exam: { label: string; from: string; to: string | null } | null
  } | null
}

export type GateRequest = {
  from?: string
  to?: string
  products?: string[]
  exam?: boolean
}

export type GateApi = {
  overview: (strategyId: string) => Promise<GateOverview>
  /** Starts a run; `run_id` is null while the server is still creating it. */
  start: (
    strategyId: string,
    request: GateRequest,
  ) => Promise<{ run_id: number | null }>
  cancel: (runId: number) => Promise<void>
  /** The Markdown text of a run's report. */
  report: (runId: number) => Promise<string>
}

export function gateReportUrl(runId: number) {
  return `${STRATEGIES_API_BASE}/gate/runs/${runId}/report.md`
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

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export const gateApi: GateApi = {
  async overview(strategyId) {
    const response = await fetch(
      `${STRATEGIES_API_BASE}/strategies/${encodeURIComponent(strategyId)}/gate/runs`,
    )
    if (!response.ok) throw await failure(response)
    return (await response.json()) as GateOverview
  },
  async start(strategyId, request) {
    const response = await post(
      `${STRATEGIES_API_BASE}/strategies/${encodeURIComponent(strategyId)}/gate`,
      request,
    )
    if (!response.ok) throw await failure(response)
    return (await response.json()) as { run_id: number | null }
  },
  async cancel(runId) {
    const response = await post(
      `${STRATEGIES_API_BASE}/gate/runs/${runId}/cancel`,
      {},
    )
    if (!response.ok) throw await failure(response)
  },
  async report(runId) {
    const response = await fetch(gateReportUrl(runId))
    if (!response.ok) throw await failure(response)
    return await response.text()
  },
}
