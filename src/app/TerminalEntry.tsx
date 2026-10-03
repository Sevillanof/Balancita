import { useEffect, useState } from 'react'
import ConnectedTerminal from './ConnectedTerminal.tsx'
import FuturesTerminal from './FuturesTerminal.tsx'
import { loadTerminalBootstrap } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

export default function TerminalEntry() {
  const [mode, setMode] = useState<'legacy' | 'unavailable' | null>(null)
  const [bootstrap, setBootstrap] = useState<Awaited<
    ReturnType<typeof loadTerminalBootstrap>
  > | null>(null)
  useEffect(() => {
    let active = true
    void loadTerminalBootstrap()
      .then((value) => {
        if (active) {
          setBootstrap(value)
          setMode('unavailable')
        }
      })
      .catch((cause: unknown) => {
        if (!active) return
        const status =
          typeof cause === 'object' && cause !== null && 'status' in cause
            ? (cause as { status: unknown }).status
            : null
        setMode(status === 404 ? 'legacy' : 'unavailable')
      })
    return () => {
      active = false
    }
  }, [])
  if (bootstrap) return <FuturesTerminal bootstrap={bootstrap} />
  if (mode === 'legacy') return <ConnectedTerminal />
  if (mode === 'unavailable')
    return (
      <main role="alert">
        <h1>Terminal de futuros no disponible</h1>
        <p>
          El servidor no confirmó un modo de simulación. Iniciá el backend con
          FUTURES_MODE=mock para usar la terminal determinista.
        </p>
      </main>
    )
  return (
    <main role="status" aria-busy="true">
      Verificando modo del servidor…
    </main>
  )
}
