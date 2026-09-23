import SimulationsPanel from './SimulationsPanel'
import { useSimulationsReport } from './useSimulationsReport'

/**
 * Mounts the report fetch only when the user opens the view, so the
 * dashboard never requests simulations unprompted.
 */
export default function SimulationsSection() {
  const { status, file, error, retry } = useSimulationsReport()
  return (
    <SimulationsPanel
      status={status}
      file={file}
      error={error}
      onRetry={() => {
        void retry()
      }}
    />
  )
}
