import { withDb, num, rowOf, type Row } from './observability-health.ts'

/**
 * Qwen's own decisions for the Terminal, read-only from Q's decisions DB
 * (`paper_futures_llm_decisions`, question `trade_action`): one row per product
 * and minute that Qwen decided. buy = LONG, sell = SHORT, hold = WAIT. Nothing
 * here writes, launches or infers; a source that cannot be read says why.
 */
const PRODUCT = /^PF_[A-Z0-9]{2,16}$/
const QUESTION = 'trade_action'
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const ACTIONS: Record<string, 'LONG' | 'SHORT' | 'WAIT'> = {
  buy: 'LONG',
  sell: 'SHORT',
  hold: 'WAIT',
}

export interface QwenDecision {
  readonly product: string
  readonly bucket_start_ms: number
  readonly action: 'LONG' | 'SHORT' | 'WAIT'
  readonly chosen: string
  readonly confidence: number
  readonly latency_ms: number
  readonly written_at_ms: number
  readonly question_version: number
}

export type QwenDecisionsResponse =
  | { readonly status: 'ok'; readonly decisions: readonly QwenDecision[] }
  | { readonly status: 'off' | 'error'; readonly reason: string }

export interface QwenDecisions {
  report(product: string, limit?: number): QwenDecisionsResponse
}

export function qwenDecisionsOff(reason: string): QwenDecisions {
  return { report: () => ({ status: 'off', reason }) }
}

export function createQwenDecisions(options: {
  readonly decisionsDbPath: string | undefined
}): QwenDecisions {
  return {
    report(product, limit = DEFAULT_LIMIT) {
      if (!PRODUCT.test(product))
        return { status: 'error', reason: 'invalid_product' }
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        return { status: 'error', reason: 'invalid_limit' }
      const opened = withDb(options.decisionsDbPath, (db) =>
        db
          .prepare(
            `SELECT bucket_start, chosen, confidence, latency_ms, written_at, question_version
               FROM paper_futures_llm_decisions
              WHERE product_id=? AND question_id=?
              ORDER BY bucket_start DESC LIMIT ?`,
          )
          .all(product, QUESTION, limit)
          .map((row) => rowOf(row)),
      )
      if (opened.state !== 'read')
        return { status: 'off', reason: opened.detail }
      const decisions: QwenDecision[] = []
      for (const row of opened.value as Row[]) {
        const bucket = num(row.bucket_start)
        const chosen = String(row.chosen)
        const action = ACTIONS[chosen]
        if (bucket === null || !action) continue
        decisions.push({
          product,
          bucket_start_ms: bucket,
          action,
          chosen,
          confidence: num(row.confidence) ?? 0,
          latency_ms: num(row.latency_ms) ?? 0,
          written_at_ms: num(row.written_at) ?? bucket,
          question_version: num(row.question_version) ?? 0,
        })
      }
      return { status: 'ok', decisions }
    },
  }
}
