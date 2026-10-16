import SessionBlocksView from '../features/paper-session/presentation/SessionBlocksView.tsx'
import { terminalApiBase } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { AppShell } from '../shared/mission-control/index.ts'
import { appNavigation } from './app-navigation.ts'
import AppStatusChips from './AppStatusChips.tsx'

/**
 * Estado de la sesión paper: a page of the Terminal (no tab of its own), like
 * the investigation. Read-only: it shows the file the Supervisor publishes.
 */
export default function SessionPage() {
  return (
    <AppShell
      brandHref="/terminal"
      brandLabel="Balancita, ir a la terminal"
      navigation={appNavigation('terminal')}
      status={<AppStatusChips apiBase={terminalApiBase('live')} />}
    >
      <SessionBlocksView />
    </AppShell>
  )
}
