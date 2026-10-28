import { useEffect, useState, type ReactNode } from 'react'
import FuturesTerminal from './FuturesTerminal.tsx'
import {
  loadTerminalBootstrap,
  terminalApiBase,
  TERMINAL_BOOTSTRAP_TIMEOUT_MS,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

// A slow or failed bootstrap is usually transient (busy gateway), so the
// terminal keeps retrying on its own instead of staying "unavailable".
export const TERMINAL_RETRY_MS = 3_000

// Since 2025-10-27 paper trades ETH only; BTC stays selectable as context.
export const DEFAULT_TERMINAL_PRODUCT = 'PF_ETHUSD'

/** After this long the loading message admits it is slower than usual. */
export const TERMINAL_SLOW_MS = 4_000

/** What went wrong, in plain words: the cause and what to check. */
function describeBootstrapFailure(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number')
    return `El servidor respondió con el error ${status}. Mirá la terminal donde corre pnpm dev: ahí aparece el motivo.`
  if (error instanceof DOMException && error.name === 'AbortError')
    return `El servidor no respondió en ${TERMINAL_BOOTSTRAP_TIMEOUT_MS / 1000} segundos. Puede estar arrancando o muy ocupado (por ejemplo, descargando datos). Se reintenta solo.`
  if (error instanceof TypeError)
    return 'No se pudo alcanzar el servidor. Verificá que pnpm run dev esté corriendo.'
  return error instanceof Error && error.message
    ? error.message
    : 'Error desconocido al pedir los datos al servidor.'
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-solid border-line border-t-info"
    />
  )
}

function TerminalView() {
  const [product, setProduct] = useState<string | undefined>(
    DEFAULT_TERMINAL_PRODUCT,
  )
  const [state, setState] = useState<
    | { kind: 'loading' }
    | {
        kind: 'ready'
        bootstrap: Awaited<ReturnType<typeof loadTerminalBootstrap>>
      }
    | { kind: 'unavailable'; reason: string }
  >({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [slow, setSlow] = useState(false)
  const apiBase = terminalApiBase()
  useEffect(() => {
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const slowTimer = setTimeout(() => setSlow(true), TERMINAL_SLOW_MS)
    void loadTerminalBootstrap(apiBase, product)
      .then((bootstrap) => {
        if (!active) return
        setSlow(false)
        setState({ kind: 'ready', bootstrap })
      })
      .catch((error: unknown) => {
        if (!active) return
        setState({
          kind: 'unavailable',
          reason: describeBootstrapFailure(error),
        })
        retry = setTimeout(() => setAttempt((n) => n + 1), TERMINAL_RETRY_MS)
      })
    return () => {
      active = false
      clearTimeout(retry)
      clearTimeout(slowTimer)
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
                if (event.target.value === (product ?? products[0])) return
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
        <main role="alert" className="flex flex-col gap-2">
          <h1>Terminal de futuros no disponible</h1>
          <p>
            No se pudo conectar con la fuente «Real (paper, Kraken público)». No
            se cambió a otra fuente automáticamente.
          </p>
          <p>Motivo: {state.reason}</p>
          <p className="flex items-center gap-2">
            <Spinner />
            Reintentando automáticamente…
          </p>
        </main>
      </SwitchBar>
    )
  return (
    <SwitchBar>
      <main role="status" aria-busy="true" className="flex items-center gap-2">
        <Spinner />
        <span>
          Cargando la Terminal (Real, paper)…
          {slow
            ? ' Está tardando más de lo normal: el servidor puede estar arrancando o ocupado. Se sigue intentando.'
            : ''}
        </span>
      </main>
    </SwitchBar>
  )
}

/** Dark frame for states where the terminal header is not rendered. */
function SwitchBar({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-canvas font-sans text-body text-ink font-features-terminal">
      <div className="flex justify-end border-b border-b-solid border-b-line px-7 py-2 source-phone:px-4">
        {children}
      </div>
    </div>
  )
}

export default function TerminalEntry() {
  return <TerminalView />
}
