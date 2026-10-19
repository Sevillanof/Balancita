import { useEffect, useState } from 'react'
import StrategyLab from '../features/strategy-lab/presentation/StrategyLab.tsx'
import { FundingChips } from '../features/strategy-lab/presentation/FundingChips.tsx'
import type { ForwardHealth } from '../features/strategy-lab/infrastructure/strategy-api.ts'
import { AppShell } from '../shared/mission-control/index.ts'
import { appNavigation } from './app-navigation.ts'
import AppStatusChips from './AppStatusChips.tsx'
import { useHealth } from '../features/observability/presentation/useHealth.ts'
import { terminalApiBase } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

export default function LaboratoryPage() {
  const health = useHealth()
  // `undefined` until the strategies page has read the inventory; `null` when the service reads no forward.
  const [funding, setFunding] = useState<
    ForwardHealth['funding'] | null | undefined
  >(undefined)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <AppShell
      brandHref="/terminal"
      brandLabel="Balancita, ir a la terminal"
      navigation={appNavigation('estrategias')}
      status={
        <>
          <FundingChips funding={funding} now={now} />
          <AppStatusChips apiBase={terminalApiBase('live')} b1={health} />
        </>
      }
    >
      <StrategyLab onFunding={setFunding} />
    </AppShell>
  )
}
