import SimulationsPanel from './SimulationsPanel.tsx'
import { useSimulationsReport } from './useSimulationsReport.ts'

/**
 * Mounts the report fetch only when the user opens the view, so the
 * dashboard never requests simulations unprompted.
 */
export default function SimulationsSection() {
  const { status, file, error, retry, refresh, refreshing, refreshError } =
    useSimulationsReport()
  return (
    <SimulationsPanel
      status={status}
      file={file}
      error={error}
      onRetry={() => {
        void retry()
      }}
      onRefresh={() => {
        void refresh()
      }}
      refreshing={refreshing}
      refreshError={refreshError}
    />
  )
}
