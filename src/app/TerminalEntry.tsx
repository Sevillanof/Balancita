import { useEffect, useState } from 'react'
import FuturesTerminal from './FuturesTerminal.tsx'
import { TerminalLoading, TerminalUnavailable } from './TerminalLoading.tsx'
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
    return status === 502 || status === 503 || status === 504
      ? `El servidor está arrancando o sobrecargado (error ${status}). Suele resolverse solo en unos segundos.`
      : `El servidor tuvo un problema interno (error ${status}).`
  if (error instanceof DOMException && error.name === 'AbortError')
    return `El servidor tardó más de ${TERMINAL_BOOTSTRAP_TIMEOUT_MS / 1000} segundos en responder. Probablemente esté arrancando o muy ocupado.`
  if (error instanceof TypeError)
    return 'No se pudo alcanzar el servidor. Puede estar apagado o reiniciándose.'
  return error instanceof Error && error.message
    ? error.message
    : 'Error desconocido al pedir los datos al servidor.'
}

function TerminalView() {
  const product = DEFAULT_TERMINAL_PRODUCT
  const [state, setState] = useState<
    | { kind: 'loading' }
    | {
        kind: 'ready'
        bootstrap: Awaited<ReturnType<typeof loadTerminalBootstrap>>
      }
    | { kind: 'unavailable'; reason: string; retryAtMs: number }
  >({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const apiBase = terminalApiBase()
  useEffect(() => {
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    void loadTerminalBootstrap(apiBase, product)
      .then((bootstrap) => {
        if (!active) return
        setState({ kind: 'ready', bootstrap })
      })
      .catch((error: unknown) => {
        if (!active) return
        setState({
          kind: 'unavailable',
          reason: describeBootstrapFailure(error),
          retryAtMs: Date.now() + TERMINAL_RETRY_MS,
        })
        retry = setTimeout(() => setAttempt((n) => n + 1), TERMINAL_RETRY_MS)
      })
    return () => {
      active = false
      clearTimeout(retry)
    }
  }, [apiBase, product, attempt])
  if (state.kind === 'ready') {
    return (
      <FuturesTerminal
        key={product}
        bootstrap={state.bootstrap}
        apiBase={apiBase}
        product={product}
      />
    )
  }
  if (state.kind === 'unavailable')
    return (
      <TerminalUnavailable
        product={product}
        reason={state.reason}
        retryAtMs={state.retryAtMs}
        attempts={attempt + 1}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    )
  return (
    <TerminalLoading
      product={product}
      timeoutMs={TERMINAL_BOOTSTRAP_TIMEOUT_MS}
      slowMs={TERMINAL_SLOW_MS}
    />
  )
}

export default function TerminalEntry() {
  return <TerminalView />
}
