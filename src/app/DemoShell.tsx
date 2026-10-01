import './DemoShell.css'
import TerminalView from '../features/demo/trading/TerminalView.tsx'
import HistoricalView from '../features/demo/history/HistoricalView.tsx'
import { historicalDemoProvider } from '../features/demo/history/provider.ts'

const terminalPath = '/demo'
const historicalPath = '/demo/historicas'

export default function DemoShell() {
  const historical = window.location.pathname === historicalPath
  const activePath = historical ? historicalPath : terminalPath
  const title = historical ? 'Pruebas históricas' : 'Terminal'

  return (
    <div className="demo-shell">
      <header className="demo-shell__header">
        <div className="demo-shell__header-inner">
          <a
            className="demo-shell__brand"
            href={terminalPath}
            aria-label="Balancita, ir a la terminal demo"
          >
            <span className="demo-shell__brand-mark" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M22 12h-4l-3 9L9 3l-3 9H2"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>
              balancita<span className="demo-shell__brand-period">.</span>
            </span>
          </a>
          <nav
            className="demo-shell__navigation"
            aria-label="Navegación principal"
          >
            <a
              className="demo-shell__nav-link"
              href={terminalPath}
              aria-current={activePath === terminalPath ? 'page' : undefined}
            >
              Terminal
            </a>
            <a
              className="demo-shell__nav-link"
              href={historicalPath}
              aria-current={activePath === historicalPath ? 'page' : undefined}
            >
              Pruebas históricas
            </a>
          </nav>
          <div className="demo-shell__status">
            <span className="demo-shell__engine-status">
              <span aria-hidden="true" /> Motor simulado
            </span>
            <span className="demo-shell__badge">DEMO · DATOS SIMULADOS</span>
            <a className="demo-shell__existing-link" href="/">
              Aplicación actual
            </a>
          </div>
        </div>
      </header>
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
