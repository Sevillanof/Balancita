import SimulationsPanel from './SimulationsPanel.tsx'
import { useSimulationsReport } from './useSimulationsReport.ts'

/**
 * Mounts the report fetch only when the user opens the view, so the
 * dashboard never requests simulations unprompted.
 */
export default function SimulationsSection() {
  const {
    status,
    file,
    error,
    retry,
    refresh,
    refreshing,
    refreshError,
    history,
    historyStatus,
    historyError,
    selectedHistoryId,
    selectHistory,
  } = useSimulationsReport()
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
      onSample={(stage, seed) => {
        void refresh({ stage, seed })
      }}
      refreshing={refreshing}
      refreshError={refreshError}
      history={history}
      historyStatus={historyStatus}
      historyError={historyError}
      selectedHistoryId={selectedHistoryId}
      onSelectHistory={(id) => {
        void selectHistory(id)
      }}
    />
  )
}
