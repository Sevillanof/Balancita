import { useCallback, useEffect, useState } from 'react'
import type { VbtState, VectorbtApi } from '../infrastructure/vectorbt-api.ts'

/** While an exploration runs the screen asks again every 2,5 s; the poll also resumes it after a page reload. */
export const VBT_POLL_MS = 2500

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * The VectorBT state of one strategy: availability, the exploration in
 * progress (if any) and the finished ones. Polls while one runs, so a
 * reloaded page picks the running exploration up again from the server.
 */
export function useVectorbt(strategyId: string, api: VectorbtApi) {
  const [state, setState] = useState<VbtState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const running = state?.running != null
  // Another strategy's exploration also blocks this one: look again, slower.
  const elsewhere = state?.busy_with != null

  useEffect(() => {
    let alive = true
    api.status(strategyId).then(
      (next) => {
        if (!alive) return
        setState(next)
        setError(null)
      },
      (failure: unknown) => {
        if (alive) setError(message(failure))
      },
    )
    return () => {
      alive = false
    }
  }, [api, strategyId, tick])

  useEffect(() => {
    if (!running && !elsewhere) return
    const timer = setInterval(
      () => setTick((value) => value + 1),
      running ? VBT_POLL_MS : VBT_POLL_MS * 4,
    )
    return () => clearInterval(timer)
  }, [running, elsewhere])

  const refresh = useCallback(() => setTick((value) => value + 1), [])
  return { state, error, refresh }
}
