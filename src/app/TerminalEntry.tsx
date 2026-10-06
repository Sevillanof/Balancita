import { useEffect, useState, type ReactNode } from 'react'
import './DemoShell.css'
import './ConnectedTerminal.css'
import ConnectedTerminal from './ConnectedTerminal.tsx'
import FuturesTerminal from './FuturesTerminal.tsx'
import {
  loadTerminalBootstrap,
  terminalApiBase,
  type TerminalSource,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

const STORAGE_KEY = 'balancita.terminal.source'

const SOURCE_LABELS: Record<TerminalSource, string> = {
  mock: 'MOCK',
  live: 'Real (paper, Kraken público)',
  legacy: 'Servidor heredado (/api)',
}

function isSource(value: unknown): value is TerminalSource {
  return value === 'mock' || value === 'live' || value === 'legacy'
}

function initialSource(): TerminalSource {
  const fromUrl = new URLSearchParams(window.location.search).get('source')
  if (isSource(fromUrl)) return fromUrl
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    // `legacy` is an explicit URL-only escape hatch, never remembered.
    if (stored === 'mock' || stored === 'live') return stored
  } catch {
    // Storage can be unavailable; the default applies.
  }
  return 'mock'
}

function persistSource(source: TerminalSource) {
  const url = new URL(window.location.href)
  url.searchParams.set('source', source)
  window.history.replaceState(window.history.state, '', url)
  if (source === 'legacy') return
  try {
    window.localStorage.setItem(STORAGE_KEY, source)
  } catch {
    // Persisting the choice is a convenience only.
  }
}

function syncUrl(source: TerminalSource) {
  const url = new URL(window.location.href)
  if (url.searchParams.get('source') === source) return
  url.searchParams.set('source', source)
  window.history.replaceState(window.history.state, '', url)
}

function SourceView({
  source,
  switchControl,
}: {
  source: TerminalSource
  switchControl: ReactNode
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | {
        kind: 'ready'
        bootstrap: Awaited<ReturnType<typeof loadTerminalBootstrap>>
      }
    | { kind: 'legacy' }
    | { kind: 'unavailable' }
  >({ kind: 'loading' })
  const apiBase = terminalApiBase(source)
  useEffect(() => {
    let active = true
    void loadTerminalBootstrap(apiBase)
      .then((bootstrap) => {
        if (active) setState({ kind: 'ready', bootstrap })
      })
      .catch((cause: unknown) => {
        if (!active) return
        const status =
          typeof cause === 'object' && cause !== null && 'status' in cause
            ? (cause as { status: unknown }).status
            : null
        // Only the explicit legacy source may render the legacy terminal.
        setState({
          kind:
            source === 'legacy' && status === 404 ? 'legacy' : 'unavailable',
        })
      })
    return () => {
      active = false
    }
  }, [apiBase, source])
  if (state.kind === 'ready')
    return (
      <FuturesTerminal
        bootstrap={state.bootstrap}
        apiBase={apiBase}
        sourceSwitch={switchControl}
      />
    )
  if (state.kind === 'legacy')
    return (
      <>
        <SwitchBar>{switchControl}</SwitchBar>
        <ConnectedTerminal />
      </>
    )
  if (state.kind === 'unavailable')
    return (
      <SwitchBar>
        {switchControl}
        <main role="alert">
          <h1>Terminal de futuros no disponible</h1>
          <p>
            No se pudo conectar con la fuente «{SOURCE_LABELS[source]}». No se
            cambió a otra fuente automáticamente.
            {source === 'mock' && ' Inicia la app con pnpm run dev.'}
            {source === 'live' &&
              ' Inicia la app con pnpm run dev y verifica la conexión con Kraken.'}
          </p>
        </main>
      </SwitchBar>
    )
  return (
    <SwitchBar>
      {switchControl}
      <main role="status" aria-busy="true">
        Verificando modo del servidor ({SOURCE_LABELS[source]})…
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
  const [source, setSource] = useState<TerminalSource>(initialSource)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    syncUrl(source)
  }, [source])
  const options: TerminalSource[] =
    source === 'legacy' ? ['mock', 'live', 'legacy'] : ['mock', 'live']
  const switchControl = (
    <>
      <div
        role="radiogroup"
        aria-label="Fuente de datos"
        className="source-switch"
      >
        {options.map((option) => (
          <label key={option} className="source-switch__option">
            <input
              type="radio"
              name="terminal-source"
              className="source-switch__input"
              checked={source === option}
              onChange={() => {
                persistSource(option)
                setSource(option)
                setAnnouncement(`Fuente cambiada a ${SOURCE_LABELS[option]}.`)
              }}
            />
            <span className="source-switch__label">
              {SOURCE_LABELS[option]}
            </span>
          </label>
        ))}
      </div>
    </>
  )
  return (
    <>
      <span className="source-switch__announce" aria-live="polite">
        {announcement}
      </span>
      <SourceView key={source} source={source} switchControl={switchControl} />
    </>
  )
}
