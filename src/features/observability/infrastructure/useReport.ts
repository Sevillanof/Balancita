import { useCallback, useEffect, useRef, useState } from 'react'

/** One read per half minute: the gateway caches 15 s, so this is not polling. */
export const REPORT_POLL_MS = 30_000

export type ReportState<T> = {
  /** Last report received, kept while a refresh is running or failed. */
  data: T | null
  /** Client time of that report (epoch ms), never the server's. */
  receivedAt: number | null
  loading: boolean
  /** The latest attempt failed; `data` (if any) is then older than shown. */
  error: string | null
  reload: () => void
}

/**
 * Loads a report now, again every `REPORT_POLL_MS` while the tab is visible, and
 * whenever `load` changes. A failed refresh keeps the previous report but flags
 * the error so the screen never presents old data as the current read.
 */
export function useReport<T>(
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
): ReportState<T> {
  const [data, setData] = useState<T | null>(null)
  const [receivedAt, setReceivedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled) return
    let active = true
    const run = () => {
      controller.current?.abort()
      const abort = new AbortController()
      controller.current = abort
      setLoading(true)
      load(abort.signal)
        .then((report) => {
          if (!active || abort.signal.aborted) return
          setData(report)
          setReceivedAt(Date.now())
          setError(null)
        })
        .catch((cause: unknown) => {
          if (!active || abort.signal.aborted) return
          setError(cause instanceof Error ? cause.message : 'error desconocido')
        })
        .finally(() => {
          if (active && !abort.signal.aborted) setLoading(false)
        })
    }
    run()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') run()
    }, REPORT_POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
      controller.current?.abort()
    }
  }, [load, tick, enabled])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { data, receivedAt, loading, error, reload }
}
