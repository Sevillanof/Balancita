import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalEntry from './TerminalEntry.tsx'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

vi.mock('./FuturesTerminal.tsx', async () => {
  const react = await import('react')
  return {
    default: ({
      bootstrap,
      apiBase,
      sourceSwitch,
    }: {
      bootstrap: { mode: string }
      apiBase?: string
      sourceSwitch?: import('react').ReactNode
    }) => {
      react.useEffect(() => {
        lifecycle.mounts += 1
        return () => {
          lifecycle.unmounts += 1
        }
      }, [])
      return (
        <div>
          {sourceSwitch}
          <p data-testid="futures-terminal">
            {bootstrap.mode} via {apiBase}
          </p>
        </div>
      )
    },
  }
})
vi.mock('./ConnectedTerminal.tsx', () => ({
  default: () => <p>legacy terminal</p>,
}))

function bootstrapBody(mode: 'mock' | 'paper_live') {
  return {
    schema_version: 1,
    mode,
    source: mode === 'mock' ? 'local-protection.v1' : 'kraken-futures',
    active_run_id: 'run-1',
  }
}

function stubFetch(
  handler: (url: string) => { status: number; body?: unknown },
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const { status, body } = handler(String(input))
    return { ok: status < 400, status, json: async () => body ?? {} }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.pushState({}, '', '/terminal')
  lifecycle.mounts = 0
  lifecycle.unmounts = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TerminalEntry source switch', () => {
  it('defaults to MOCK and loads the bootstrap from /api-mock', async () => {
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: bootstrapBody('mock'),
    }))
    render(<TerminalEntry />)
    expect(await screen.findByTestId('futures-terminal')).toHaveTextContent(
      'mock via /api-mock',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api-mock/terminal/bootstrap',
      expect.anything(),
    )
    expect(screen.getByRole('radio', { name: 'MOCK' })).toBeChecked()
  })

  it('honours ?source=live from the URL', async () => {
    window.history.pushState({}, '', '/terminal?source=live')
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: bootstrapBody('paper_live'),
    }))
    render(<TerminalEntry />)
    expect(await screen.findByTestId('futures-terminal')).toHaveTextContent(
      'paper_live via /api-live',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api-live/terminal/bootstrap',
      expect.anything(),
    )
    expect(
      screen.getByRole('radio', { name: 'Real (paper, Kraken público)' }),
    ).toBeChecked()
  })

  it('switches source, remounts the terminal, and persists the choice', async () => {
    const fetchMock = stubFetch((url) =>
      url.startsWith('/api-live')
        ? { status: 200, body: bootstrapBody('paper_live') }
        : { status: 200, body: bootstrapBody('mock') },
    )
    render(<TerminalEntry />)
    await screen.findByText('mock via /api-mock')
    await userEvent.click(
      screen.getByRole('radio', { name: 'Real (paper, Kraken público)' }),
    )
    expect(await screen.findByText('paper_live via /api-live')).toBeVisible()
    expect(screen.queryByText('mock via /api-mock')).not.toBeInTheDocument()
    expect(lifecycle.unmounts).toBe(1)
    expect(lifecycle.mounts).toBe(2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api-live/terminal/bootstrap',
      expect.anything(),
    )
    expect(window.location.search).toBe('?source=live')
    expect(window.localStorage.getItem('balancita.terminal.source')).toBe(
      'live',
    )
  })

  it('uses the stored choice when the URL has no source', async () => {
    window.localStorage.setItem('balancita.terminal.source', 'live')
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: bootstrapBody('paper_live'),
    }))
    render(<TerminalEntry />)
    await screen.findByTestId('futures-terminal')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api-live/terminal/bootstrap',
      expect.anything(),
    )
  })

  it('names the selected source on failure and never falls back to the other', async () => {
    const fetchMock = stubFetch(() => ({ status: 502 }))
    window.history.pushState({}, '', '/terminal?source=live')
    render(<TerminalEntry />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Real (paper, Kraken público)')
    expect(screen.queryByTestId('futures-terminal')).not.toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api-live/terminal/bootstrap',
    ])
    // The switch stays available so the person can choose MOCK explicitly.
    expect(screen.getByRole('radio', { name: 'MOCK' })).toBeInTheDocument()
  })

  it('treats an unreachable backend (network error) as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    render(<TerminalEntry />)
    expect(await screen.findByRole('alert')).toHaveTextContent('MOCK')
  })

  it('keeps the legacy terminal reachable only through ?source=legacy', async () => {
    window.history.pushState({}, '', '/terminal?source=legacy')
    const fetchMock = stubFetch(() => ({ status: 404 }))
    render(<TerminalEntry />)
    expect(await screen.findByText('legacy terminal')).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/terminal/bootstrap',
      expect.anything(),
    )
  })

  it('reflects the applied source in the URL when /terminal has no query', async () => {
    stubFetch(() => ({ status: 200, body: bootstrapBody('mock') }))
    render(<TerminalEntry />)
    await screen.findByTestId('futures-terminal')
    expect(window.location.search).toBe('?source=mock')
  })

  it('exposes one accessible "Fuente de datos" radiogroup with native radios', async () => {
    stubFetch(() => ({ status: 200, body: bootstrapBody('mock') }))
    render(<TerminalEntry />)
    await screen.findByTestId('futures-terminal')
    const group = screen.getByRole('radiogroup', { name: 'Fuente de datos' })
    expect(group).toHaveClass('source-switch')
    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByRole('radio', { name: 'MOCK' })).toBeChecked()
  })

  it('announces a source change politely', async () => {
    stubFetch((url) =>
      url.startsWith('/api-live')
        ? { status: 200, body: bootstrapBody('paper_live') }
        : { status: 200, body: bootstrapBody('mock') },
    )
    render(<TerminalEntry />)
    await screen.findByText('mock via /api-mock')
    expect(screen.queryByText(/Fuente cambiada/)).toBeNull()
    await userEvent.click(
      screen.getByRole('radio', { name: 'Real (paper, Kraken público)' }),
    )
    const note = await screen.findByText(
      'Fuente cambiada a Real (paper, Kraken público).',
    )
    expect(note).toHaveAttribute('aria-live', 'polite')
  })

  it('uses neutral Spanish (no voseo) in the unavailable copy', async () => {
    stubFetch(() => ({ status: 503 }))
    render(<TerminalEntry />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Inicia la app con pnpm run dev')
    expect(alert).not.toHaveTextContent(/Iniciá|verificá/)
  })

  it('keeps the switch usable while the backend is unavailable', async () => {
    stubFetch(() => ({ status: 503 }))
    render(<TerminalEntry />)
    await screen.findByRole('alert')
    expect(
      screen.getByRole('radiogroup', { name: 'Fuente de datos' }),
    ).toBeInTheDocument()
  })
})
