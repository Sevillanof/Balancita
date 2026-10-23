import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'

export const QWEN_STRATEGY_ID = 'qwen'
const POLL_MS = 15_000
const EMPTY: Record<string, unknown>[] = []

/**
 * Qwen's own decisions of one product, read from the gateway
 * (`/api/qwen/decisions`), shaped like the analyses the Terminal already draws
 * (marker, history row, detail). A source that is off or fails gives none:
 * nothing is invented.
 */
export function qwenAnalyses(payload: unknown): Record<string, unknown>[] {
  const body = record(payload)
  if (body.status !== 'ok' || !Array.isArray(body.decisions)) return []
  return body.decisions
    .map(record)
    .filter(
      (row) =>
        typeof row.product === 'string' &&
        Number.isSafeInteger(row.bucket_start_ms) &&
        typeof row.action === 'string',
    )
    .map((row) => ({
      analysis_id: `qwen:${row.product}:${row.bucket_start_ms}`,
      product: row.product,
      bucket_start_ms: row.bucket_start_ms,
      decision_time_ms: row.written_at_ms ?? row.bucket_start_ms,
      action: row.action,
      selected_strategy_id: QWEN_STRATEGY_ID,
      selector: { strategy_id: QWEN_STRATEGY_ID, action: row.action },
      reason_code: `qwen_${String(row.chosen)}`,
      confidence: row.confidence,
    }))
    .sort((a, b) => Number(a.decision_time_ms) - Number(b.decision_time_ms))
}

export function useQwenDecisions(
  product: string | undefined,
  enabled: boolean,
): Record<string, unknown>[] {
  // Rows belong to the product they were read for: another product shows none.
  const [read, setRead] = useState<{
    product: string
    rows: Record<string, unknown>[]
  } | null>(null)
  useEffect(() => {
    if (!enabled || !product) return
    const controller = new AbortController()
    const load = async () => {
      try {
        const response = await fetch(
          `/api-live/qwen/decisions?product=${encodeURIComponent(product)}&limit=100`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setRead({ product, rows: qwenAnalyses(await response.json()) })
      } catch {
        if (!controller.signal.aborted) setRead({ product, rows: [] })
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [product, enabled])
  return enabled && read && read.product === product ? read.rows : EMPTY
}
