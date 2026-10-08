import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalEntry from './TerminalEntry.tsx'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

vi.mock('./FuturesTerminal.tsx', async () => {
  const react = await import('react')
  return {
    default: ({
      bootstrap,
      apiBase,
    }: {
      bootstrap: { mode: string }
      apiBase?: string
    }) => {
      react.useEffect(() => {
        lifecycle.mounts += 1
        return () => {
          lifecycle.unmounts += 1
        }
      }, [])
      return (
        <div>
          <p data-testid="futures-terminal">
            {bootstrap.mode} via {apiBase}
          </p>
        </div>
      )
    },
  }
})

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

describe('TerminalEntry', () => {
  it('always loads the live source, with no source switch', async () => {
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: bootstrapBody('paper_live'),
    }))
    render(<TerminalEntry />)
    expect(await screen.findByTestId('futures-terminal')).toHaveTextContent(
      'paper_live via /api-live',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api-live/terminal/bootstrap',
      expect.anything(),
    )
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('ignores ?source=mock: MOCK is not used any more', async () => {
    window.history.pushState({}, '', '/terminal?source=mock')
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

  it('reports an unreachable backend without falling back to anything else', async () => {
    stubFetch(() => ({ status: 503 }))
    render(<TerminalEntry />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Terminal de futuros no disponible',
    )
    expect(screen.queryByTestId('futures-terminal')).toBeNull()
  })

  it('treats a network error as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network')
      }),
    )
    render(<TerminalEntry />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Real')
  })
})
