import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppStatusChips from './AppStatusChips.tsx'

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AppStatusChips', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the quote time the live gateway reports in /health', async () => {
    // The shape `GET /api-live/health` returns: capture time in camelCase.
    const health = {
      process: 'live-gateway',
      capture: { status: 'live', reason: null, lastReceivedAt: Date.now() },
      processes: { capture: { status: 'running' }, live: { status: 'running' } },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/health') ? json(health) : json({}),
      ),
    )
    render(<AppStatusChips apiBase="/api-live" showUsage={false} />)
    expect(await screen.findByText('En vivo')).toBeInTheDocument()
    expect(screen.queryByText('Sin precio recibido todavía')).toBeNull()
  })
})
