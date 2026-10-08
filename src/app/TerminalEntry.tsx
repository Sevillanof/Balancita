import { useEffect, useState, type ReactNode } from 'react'
import './DemoShell.css'
import './ConnectedTerminal.css'
import FuturesTerminal from './FuturesTerminal.tsx'
import {
  loadTerminalBootstrap,
  terminalApiBase,
  type TerminalSource,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

// The terminal always reads the live gateway (paper orders, public Kraken
// data); the MOCK source is not offered any more.
const SOURCE: TerminalSource = 'live'

function SourceView({ source }: { source: TerminalSource }) {
  const [product, setProduct] = useState<string | undefined>(undefined)
  const [state, setState] = useState<
    | { kind: 'loading' }
    | {
        kind: 'ready'
        bootstrap: Awaited<ReturnType<typeof loadTerminalBootstrap>>
      }
    | { kind: 'unavailable' }
  >({ kind: 'loading' })
  const apiBase = terminalApiBase(source)
  useEffect(() => {
    let active = true
    void loadTerminalBootstrap(apiBase, product)
      .then((bootstrap) => {
        if (active) setState({ kind: 'ready', bootstrap })
      })
      .catch(() => {
        if (active) setState({ kind: 'unavailable' })
      })
    return () => {
      active = false
    }
  }, [apiBase, product])
  if (state.kind === 'ready') {
    const products = state.bootstrap.products ?? []
    return (
      <FuturesTerminal
        key={product ?? 'default'}
        bootstrap={state.bootstrap}
        apiBase={apiBase}
        product={product}
        sourceSwitch={
          products.length > 1 ? (
            <select
              aria-label="Producto"
              value={product ?? products[0]}
              onChange={(event) => {
                setState({ kind: 'loading' })
                setProduct(event.target.value)
              }}
            >
              {products.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />
    )
  }
  if (state.kind === 'unavailable')
    return (
      <SwitchBar>
        <main role="alert">
          <h1>Terminal de futuros no disponible</h1>
          <p>
            No se pudo conectar con la fuente «Real (paper, Kraken público)». No
            se cambió a otra fuente automáticamente.
            {
              ' Inicia la app con pnpm run dev y verifica la conexión con Kraken.'
            }
          </p>
        </main>
      </SwitchBar>
    )
  return (
    <SwitchBar>
      <main role="status" aria-busy="true">
        Verificando modo del servidor (Real, paper)…
      </main>
    </SwitchBar>
  )
}

/** Dark frame for states where the terminal header is not rendered. */
function SwitchBar({ children }: { children: ReactNode }) {
  return (
    <div className="demo-shell">
      <div className="source-switch-bar">{children}</div>
    </div>
  )
}

export default function TerminalEntry() {
  return <SourceView source={SOURCE} />
}
