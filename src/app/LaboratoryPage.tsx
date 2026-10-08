import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import '@fontsource/dm-sans/latin-700.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import './DemoShell.css'
import './ConnectedTerminal.css'
import ApprovedTradingHeader from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'
import StrategyLab from '../features/strategy-lab/presentation/StrategyLab.tsx'
import ReplayPanel from '../features/strategy-lab/presentation/ReplayPanel.tsx'
import { appNavigation } from './app-navigation.ts'
import AppStatusChips from './AppStatusChips.tsx'
import { terminalApiBase } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

export default function LaboratoryPage() {
  return (
    <div className="demo-shell connected-terminal">
      <ApprovedTradingHeader
        brandHref="/terminal"
        brandLabel="Balancita, ir a la terminal"
        navigation={appNavigation('estrategias')}
        status={<AppStatusChips apiBase={terminalApiBase('live')} />}
      />
      <main className="demo-shell__main connected-terminal__main">
        <StrategyLab />
        <ReplayPanel />
      </main>
    </div>
  )
}
