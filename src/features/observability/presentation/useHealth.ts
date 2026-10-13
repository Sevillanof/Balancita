import { useCallback } from 'react'
import { fetchHealth } from '../infrastructure/observability-api.ts'
import { useReport } from '../infrastructure/useReport.ts'

/** One read of B1, shared by the header control and the observer panel. */
export function useHealth(enabled = true) {
  // Disabled (no live gateway): nothing is requested and no timer runs.
  const load = useCallback((signal: AbortSignal) => fetchHealth(signal), [])
  return useReport(load, enabled)
}
