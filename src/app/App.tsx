import LaboratoryPage from './LaboratoryPage.tsx'
import { isInvestigationPath, sectionForPath } from './app-routes.ts'
import InvestigationPage from './InvestigationPage.tsx'
import TerminalEntry from './TerminalEntry.tsx'

/**
 * Two screens: the Kraken futures paper terminal (also the landing page) and
 * the strategy laboratory. The spot BTC-EUR stack was retired (SS-13).
 */
export default function App() {
  if (isInvestigationPath(window.location.pathname))
    return <InvestigationPage />
  if (sectionForPath(window.location.pathname) === 'estrategias')
    return <LaboratoryPage />
  return <TerminalEntry />
}
