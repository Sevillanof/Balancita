import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import '@fontsource/dm-sans/latin-700.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@fontsource/ibm-plex-mono/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-700.css'
import './DemoShell.css'
import TerminalView from '../features/demo/trading/TerminalView.tsx'
import HistoricalView from '../features/demo/history/HistoricalView.tsx'
import { historicalDemoProvider } from '../features/demo/history/provider.ts'
import ApprovedTradingHeader from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'

const terminalPath = '/demo'
const historicalPath = '/demo/historicas'

export default function DemoShell() {
  const historical = window.location.pathname === historicalPath
  const activePath = historical ? historicalPath : terminalPath
  const title = historical ? 'Pruebas históricas' : 'Terminal'

  return (
    <div className="demo-shell">
      <ApprovedTradingHeader
        brandHref={terminalPath}
        brandLabel="Balancita, ir a la terminal demo"
        navigation={[
          {
            href: terminalPath,
            label: 'Terminal',
            current: activePath === terminalPath,
          },
          {
            href: historicalPath,
            label: 'Pruebas históricas',
            current: activePath === historicalPath,
          },
        ]}
        status={
          <>
            <span className="demo-shell__engine-status">
              <span aria-hidden="true" /> Motor simulado
            </span>
            <span className="demo-shell__badge">DEMO · DATOS SIMULADOS</span>
            <a className="demo-shell__existing-link" href="/">
              Aplicación actual
            </a>
          </>
        }
      />
      <div className="demo-shell__disclaimer">
        Entorno de observación. No se ejecutan órdenes reales ni se conecta a un
        exchange.
      </div>
      <main className="demo-shell__main" aria-labelledby="demo-page-title">
        <div className="demo-shell__page-heading">
          <p className="demo-shell__eyebrow">BALANCITA TRADER VIEW</p>
          <h1 id="demo-page-title">{title}</h1>
        </div>
        {historical ? (
          <HistoricalView provider={historicalDemoProvider} />
        ) : (
          <TerminalView />
        )}
      </main>
    </div>
  )
}
