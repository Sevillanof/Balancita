import LaboratoryPage from './LaboratoryPage.tsx'
import ObservabilityRoute from './ObservabilityRoute.tsx'
import { sectionForPath } from './app-routes.ts'
import TerminalEntry from './TerminalEntry.tsx'

/**
 * Three screens: the Kraken futures paper terminal (also the landing page), the
 * strategy laboratory and the read-only observability page. The spot BTC-EUR stack was retired (SS-13).
 */
export default function App() {
  const section = sectionForPath(window.location.pathname)
  if (section === 'estrategias') return <LaboratoryPage />
  if (section === 'observabilidad') return <ObservabilityRoute />
  return <TerminalEntry />
}
