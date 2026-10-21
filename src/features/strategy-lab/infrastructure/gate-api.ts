import { STRATEGIES_API_BASE } from './strategy-api.ts'

/**
 * Strategy gate through the registry S: launch a fixed test, follow its
 * progress, cancel it and download its report. The gate's own process writes
 * `gate.sqlite`; this client only reads and asks.
 */
export type GateKind = 'practice' | 'exam'
export type GateStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type GateVerdict = 'PASA' | 'NO PASA' | 'INCONCLUSO'

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
  /** True when the run is of the strategy's current content (the server marks it). */
  same_version?: boolean
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
}

export type GateRequest = { from?: string; products?: string[]; exam?: boolean }

export type GateApi = {
  overview: (strategyId: string) => Promise<GateOverview>
  start: (strategyId: string, request: GateRequest) => Promise<void>
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
