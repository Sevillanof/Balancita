import ObservabilityPage from '../features/observability/presentation/ObservabilityPage.tsx'
import { AppShell } from '../shared/mission-control/index.ts'
import { appNavigation } from './app-navigation.ts'
import AppStatusChips from './AppStatusChips.tsx'
import { terminalApiBase } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

export default function ObservabilityRoute() {
  return (
    <AppShell
      brandHref="/terminal"
      brandLabel="Balancita, ir a la terminal"
      navigation={appNavigation('observabilidad')}
      status={<AppStatusChips apiBase={terminalApiBase('live')} />}
    >
      <ObservabilityPage />
    </AppShell>
  )
}
