import { useEffect, useState } from 'react'
import {
  connectStrategyApi,
  type StrategyApi,
} from '../infrastructure/strategy-api.ts'
import StrategiesPage from './StrategiesPage.tsx'

type Props = {
  connect?: () => Promise<StrategyApi>
}

const defaultConnect = () => connectStrategyApi()

/** The Estrategias screen: connects to the registry and shows the list with the chosen strategy's card. */
export default function StrategyLab({ connect = defaultConnect }: Props) {
  const [api, setApi] = useState<StrategyApi | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    // Wait one tick so the throwaway first mount of React's dev strict mode never probes the registry.
    void Promise.resolve()
      .then(() => (active ? connect() : null))
      .then(
        (connected) => {
          if (active && connected) setApi(connected)
        },
        (error: unknown) => {
          if (active)
            setConnectError(
              error instanceof Error ? error.message : String(error),
            )
        },
      )
    return () => {
      active = false
    }
  }, [connect])

  return (
    <div className="grid gap-4 text-body">
      <StrategiesPage
        api={api}
        connectError={connectError}
        reload={0}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    </div>
  )
}
