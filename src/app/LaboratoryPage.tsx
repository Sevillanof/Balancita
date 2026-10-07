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
import { appNavigation } from './app-navigation.ts'

export default function LaboratoryPage() {
  return (
    <div className="demo-shell connected-terminal">
      <ApprovedTradingHeader
        brandHref="/terminal"
        brandLabel="Balancita, ir a la terminal"
        navigation={appNavigation('estrategias')}
        status={
          <span className="demo-shell__badge">PAPER · SIN ÓRDENES REALES</span>
        }
      />
      <main className="demo-shell__main connected-terminal__main">
        <StrategyLab />
      </main>
    </div>
  )
}
