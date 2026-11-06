import { useEffect, useState } from 'react'
import {
  connectEstrategiasApi,
  type EstrategiasApi,
} from '../infrastructure/estrategias-api.ts'
import EstrategiasPage from './EstrategiasPage.tsx'

type Props = {
  connect?: () => Promise<EstrategiasApi>
  pollMs?: number
}

const defaultConnect = () => connectEstrategiasApi()

/** The Estrategias screen: connects to the registry and shows the Terminal laboratory. */
export default function StrategyLab({
  connect = defaultConnect,
  pollMs,
}: Props) {
  const [api, setApi] = useState<EstrategiasApi | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)

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
    <EstrategiasPage api={api} connectError={connectError} pollMs={pollMs} />
  )
}
