import StrategyLab from '../features/strategy-lab/presentation/StrategyLab.tsx'
import { AppShell } from '../shared/mission-control/index.ts'
import { appNavigation } from './app-navigation.ts'
import AppStatusChips from './AppStatusChips.tsx'
import AccountBalance from './AccountBalance.tsx'
import { useHealth } from '../features/observability/presentation/useHealth.ts'
import { terminalApiBase } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

export default function LaboratoryPage() {
  const health = useHealth()
  return (
    <AppShell
      brandHref="/terminal"
      brandLabel="Balancita, ir a la terminal"
      navigation={appNavigation('estrategias')}
      center={<AccountBalance />}
      status={<AppStatusChips apiBase={terminalApiBase()} b1={health} />}
    >
      <StrategyLab />
    </AppShell>
  )
}
