import LaboratoryPage from './LaboratoryPage.tsx'
import {
  isInvestigationPath,
  isSessionPath,
  sectionForPath,
} from './app-routes.ts'
import InvestigationPage from './InvestigationPage.tsx'
import SessionPage from './SessionPage.tsx'
import TerminalEntry from './TerminalEntry.tsx'

/**
 * Two screens: the Kraken futures paper terminal (also the landing page) and
 * the strategy laboratory. The spot BTC-EUR stack was retired (SS-13).
 */
export default function App() {
  if (isInvestigationPath(window.location.pathname))
    return <InvestigationPage />
  if (isSessionPath(window.location.pathname)) return <SessionPage />
  if (sectionForPath(window.location.pathname) === 'estrategias')
    return <LaboratoryPage />
  return <TerminalEntry />
}
