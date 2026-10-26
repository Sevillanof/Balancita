import { useEffect, useState, type ReactNode } from 'react'
import '../shared/mission-control/mission-control.css'
import './DemoShell.css'
import './ConnectedTerminal.css'
import FuturesTerminal from './FuturesTerminal.tsx'
import {
  loadTerminalBootstrap,
  terminalApiBase,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

// A slow or failed bootstrap is usually transient (busy gateway), so the
// terminal keeps retrying on its own instead of staying "unavailable".
export const TERMINAL_RETRY_MS = 3_000

function TerminalView() {
  const [product, setProduct] = useState<string | undefined>(undefined)
  const [state, setState] = useState<
    | { kind: 'loading' }
    | {
        kind: 'ready'
        bootstrap: Awaited<ReturnType<typeof loadTerminalBootstrap>>
      }
    | { kind: 'unavailable' }
  >({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const apiBase = terminalApiBase()
  useEffect(() => {
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    void loadTerminalBootstrap(apiBase, product)
      .then((bootstrap) => {
        if (active) setState({ kind: 'ready', bootstrap })
      })
      .catch(() => {
        if (!active) return
        setState({ kind: 'unavailable' })
        retry = setTimeout(() => setAttempt((n) => n + 1), TERMINAL_RETRY_MS)
      })
    return () => {
      active = false
      clearTimeout(retry)
    }
  }, [apiBase, product, attempt])
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
              className="min-h-7! rounded-sm! border border-solid border-line! bg-surface-2! px-3! py-0! font-mono! text-hint! leading-control! text-ink! scheme-dark hover:bg-surface-hover! focus-visible:outline-2! focus-visible:outline-info! focus-visible:outline-offset-2!"
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
            {' Reintentando automáticamente…'}
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
    <div className="demo-shell min-h-svh bg-canvas font-sans text-body text-ink">
      <div className="flex justify-end border-b border-b-solid border-b-line px-7 py-2 source-phone:px-4">
        {children}
      </div>
    </div>
  )
}

export default function TerminalEntry() {
  return <TerminalView />
}
