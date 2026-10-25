import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'
import {
  probabilitiesText,
  skippedReason,
  waitReason,
} from './qwen-wait-reason.ts'
import { QWEN_RUNTIME } from '../features/observability/presentation/latest-decision.ts'

export const QWEN_STRATEGY_ID = 'qwen'
const POLL_MS = 15_000
const EMPTY: Record<string, unknown>[] = []
const LOADING: QwenSource = { state: 'loading' }

/**
 * Qwen operador's own decisions of one product (one every 15 minutes), read
 * from the gateway (`/api/qwen/decisions`), shaped like the analyses the
 * Terminal already draws (marker, history row, detail). A source that is off
 * or fails gives none: nothing is invented. The marker sits on the candle of
 * the instant Qwen looked at the market (`decision_time_ms`, the end of its
 * 15 minute window), not on the window's first candle.
 */
export function qwenAnalyses(payload: unknown): Record<string, unknown>[] {
  const body = record(payload)
  if (body.status !== 'ok' || !Array.isArray(body.decisions)) return []
  const skipped = (Array.isArray(body.skipped) ? body.skipped : [])
    .map(record)
    .filter(
      (row) =>
        typeof row.product === 'string' &&
        Number.isSafeInteger(row.bucket_start_ms),
    )
    .map((row) => ({
      // No runtime_version: a wake without a decision is never «the latest decision».
      analysis_id: `qwen:${row.product}:skipped:${row.bucket_start_ms}`,
      product: row.product,
      bucket_start_ms: Number.isSafeInteger(row.decision_time_ms)
        ? row.decision_time_ms
        : row.bucket_start_ms,
      decision_time_ms: row.decision_time_ms ?? row.bucket_start_ms,
      action: 'WAIT',
      selected_strategy_id: QWEN_STRATEGY_ID,
      selector: { strategy_id: QWEN_STRATEGY_ID, action: 'WAIT' },
      reason_code: 'qwen_omitida',
      qwen_why: skippedReason(row.reason, row.detail),
      qwen_skipped: true,
    }))
  const decided = body.decisions
    .map(record)
    .filter(
      (row) =>
        typeof row.product === 'string' &&
        Number.isSafeInteger(row.bucket_start_ms) &&
        typeof row.action === 'string',
    )
    .map((row) => ({
      runtime_version: QWEN_RUNTIME,
      analysis_id: `qwen:${row.product}:${row.bucket_start_ms}`,
      product: row.product,
      bucket_start_ms: Number.isSafeInteger(row.decision_time_ms)
        ? row.decision_time_ms
        : row.bucket_start_ms,
      decision_time_ms:
        row.decision_time_ms ?? row.written_at_ms ?? row.bucket_start_ms,
      action: row.action,
      selected_strategy_id: QWEN_STRATEGY_ID,
      selector: { strategy_id: QWEN_STRATEGY_ID, action: row.action },
      reason_code: `qwen_${String(row.chosen)}`,
      confidence: row.confidence,
      qwen_why: waitReason(row),
      qwen_probabilities: probabilitiesText(row.probabilities),
    }))
  return [...decided, ...skipped].sort(
    (a, b) => Number(a.decision_time_ms) - Number(b.decision_time_ms),
  )
}

function okSource(heartbeat: unknown): QwenSource {
  const beat = record(heartbeat)
  return {
    state: 'ok',
    heartbeatMs:
      typeof beat.heartbeat_ms === 'number' ? beat.heartbeat_ms : null,
    modelOk: typeof beat.model_ok === 'boolean' ? beat.model_ok : null,
  }
}

export type QwenSource =
  | { state: 'loading' }
  | { state: 'ok'; heartbeatMs?: number | null; modelOk?: boolean | null }
  | { state: 'off'; reason: string }
  | { state: 'error' }

/** What the Terminal says when Qwen has no decision to show, or null. */
export function qwenNotice(source: QwenSource, rows: number): string | null {
  if (rows > 0 || source.state === 'loading') return null
  if (source.state === 'off')
    return 'Qwen no está corriendo: no hay base de decisiones. Iniciá pnpm dev con el modelo local instalado (llama.cpp con un Qwen en GGUF); si no puede arrancar, el arranque explica el motivo.'
  if (source.state === 'error')
    return 'No se pudieron leer las decisiones de Qwen del gateway.'
  return 'Qwen todavía no decidió nada para este producto. Mira el mercado cada 15 minutos y solo actúa cuando ve una ventaja clara.'
}

const STALE_HEARTBEAT_MS = 5 * 60_000

/**
 * Plain-words warning when the operator process is silent or its model is out,
 * or null. Needs a heartbeat to say anything: an old base without one says nothing.
 */
export function qwenHealthNotice(
  source: QwenSource,
  nowMs: number,
): string | null {
  if (source.state !== 'ok') return null
  const beat = source.heartbeatMs
  if (typeof beat === 'number' && nowMs - beat >= STALE_HEARTBEAT_MS)
    return `Qwen sin latidos hace ${Math.floor((nowMs - beat) / 60_000)} min: el proceso no está escribiendo. Si pnpm dev sigue corriendo, se está relanzando solo.`
  if (source.modelOk === false)
    return 'El modelo local no responde. Qwen sigue vivo: anota cada despertar como omitido y retoma solo cuando el modelo vuelva.'
  return null
}

export function useQwenDecisions(
  product: string | undefined,
  enabled: boolean,
): { rows: Record<string, unknown>[]; source: QwenSource } {
  // Reads belong to the product they were read for: another product shows none.
  const [read, setRead] = useState<{
    product: string
    rows: Record<string, unknown>[]
    source: QwenSource
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
        const body = await response.json()
        const status = record(body).status
        setRead({
          product,
          rows: qwenAnalyses(body),
          source:
            status === 'ok'
              ? okSource(record(body).heartbeat)
              : { state: 'off', reason: String(record(body).reason ?? '') },
        })
      } catch {
        if (!controller.signal.aborted)
          setRead({ product, rows: [], source: { state: 'error' } })
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [product, enabled])
  return enabled && read && read.product === product
    ? { rows: read.rows, source: read.source }
    : { rows: EMPTY, source: LOADING }
}
