import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import documents from '../../../../docs/mission-control/b3/documento-bloques-publicador-real.json'
import { decodeSessionBlocksReading } from '../infrastructure/session-blocks-api.ts'
import SessionBlocksView, {
  SessionBlocksReadingView,
} from './SessionBlocksView.tsx'

const PILL = { selector: '.mc-pill' }

// SYNTHETIC: documents the real publisher built from invented sessions
// (python/tests/session_document_187.py). Nothing here is a real session.
const scenario = (name: keyof typeof documents) => documents[name]

/** The envelope the route answers; `degrade` mimics what the server does. */
const envelope = (
  name: keyof typeof documents,
  degrade: (doc: Record<string, unknown>) => Record<string, unknown> = (d) => d,
) => ({
  state: 'ok',
  published_at_ms: 1_800_000_000_000,
  evaluated_ms: 1_800_000_001_000,
  document: degrade(structuredClone(scenario(name)) as Record<string, unknown>),
})

const reading = (raw: unknown) => decodeSessionBlocksReading(raw)
const show = (raw: unknown) =>
  render(<SessionBlocksReadingView reading={reading(raw)} />)

afterEach(() => vi.unstubAllGlobals())

describe('decodeSessionBlocksReading', () => {
  it('decodes absent, invalid and ok, and refuses anything else', () => {
    expect(reading({ state: 'absent' })).toEqual({ state: 'absent' })
    expect(reading({ state: 'invalid', reason: 'other_run' })).toEqual({
      state: 'invalid',
      reason: 'other_run',
    })
    const ok = reading(envelope('operating_threshold_hypothesis'))
    expect(ok.state).toBe('ok')
    expect(() => reading({ state: 'quizas' })).toThrow()
    expect(() => reading({ state: 'ok' })).toThrow()
    expect(() => reading(null)).toThrow()
  })
})

describe('the session page states', () => {
  it('absent file: «Sin datos», never an empty session', () => {
    show({ state: 'absent' })
    expect(screen.getByText('Sin datos')).toBeInTheDocument()
    expect(screen.queryByTestId('session-status')).toBeNull()
  })

  it('a file of another run is shown as unusable, with its reason', () => {
    show({ state: 'invalid', reason: 'other_run' })
    expect(screen.getByText('Archivo no utilizable')).toBeInTheDocument()
    expect(screen.getByText(/otra corrida/)).toBeInTheDocument()
    expect(screen.queryByTestId('session-status')).toBeNull()
  })

  it('shows how old the document is, next to the blocks, and says when it cannot tell', () => {
    show(envelope('operating_threshold_hypothesis'))
    expect(screen.getByTestId('document-age')).toHaveTextContent('hace 1 s')
    cleanup()
    show({ ...envelope('operating_threshold_hypothesis'), evaluated_ms: 1 })
    expect(screen.getByTestId('document-age')).toHaveTextContent('no medible')
  })

  it('a running session is not shown as alive or current: no approved limit', () => {
    show(envelope('operating_threshold_hypothesis'))
    const status = screen.getByTestId('session-status')
    expect(status).toHaveAttribute('data-phase', 'LIVE')
    expect(within(status).getByText(/Latido sin confirmar/)).toBeInTheDocument()
    expect(screen.queryByText('Latido al día')).toBeNull()
    expect(screen.queryByText('Vigente')).toBeNull()
    expect(screen.getByTestId('session-validity')).toHaveAttribute(
      'data-current',
      'false',
    )
  })

  it('a running session without a confirmed heartbeat has a neutral tone and no word of life', () => {
    show(
      envelope('operating_threshold_hypothesis', (doc) => ({
        ...doc,
        status: {
          ...(doc.status as { reasons: string[] }),
          reasons: ['liveness_threshold_not_approved'],
        },
      })),
    )
    const status = screen.getByTestId('session-status')
    const pill = screen.getByText(/en marcha, sin confirmar/i, PILL)
    expect(pill).toHaveAttribute('data-tone', 'nodata')
    expect(status.textContent).not.toMatch(/vigente|viva\b|al día/i)
    expect(screen.queryByText('En marcha', PILL)).toBeNull()
    expect(
      within(status).getByText('Límite del latido no aprobado'),
    ).toBeInTheDocument()
  })

  it('only a confirmed heartbeat (alive) earns the green «En marcha»', () => {
    show(
      envelope('operating_threshold_hypothesis', (doc) => ({
        ...doc,
        status: {
          ...(doc.status as { thresholds: object }),
          liveness: 'alive',
          thresholds: {
            ...(doc.status as { thresholds: object }).thresholds,
            status: 'approved',
          },
        },
      })),
    )
    expect(screen.getByText('En marcha', PILL)).toHaveAttribute(
      'data-tone',
      'ok',
    )
  })

  it('an old file degrades the session to «Sin verificar» and says why', () => {
    show(
      envelope('operating_threshold_hypothesis', (doc) => ({
        ...doc,
        status: {
          ...(doc.status as object),
          phase: 'unverified',
          liveness: 'stale',
          gateway: { age_ms: 16_000, reason: 'heartbeat_age_over_limit' },
        },
      })),
    )
    const status = screen.getByTestId('session-status')
    expect(status).toHaveAttribute('data-phase', 'unverified')
    expect(within(status).getByText('Latido vencido')).toBeInTheDocument()
    expect(within(status).getByTestId('reported-phase')).toHaveTextContent(
      'LIVE',
    )
    expect(
      within(status).getByTestId('status-gateway-reason'),
    ).toHaveTextContent('edad 16 s')
  })

  it('a halted session shows the stop and its unverified result', () => {
    show(envelope('halted_funding_diverged'))
    const status = screen.getByTestId('session-status')
    expect(status).toHaveAttribute('data-phase', 'HALTED')
    expect(within(status).getByText('Sesión terminada')).toBeInTheDocument()
    expect(within(status).getByTestId('halt-reason')).toBeInTheDocument()
    expect(within(status).getByTestId('funding-source')).toHaveTextContent(
      'resultado sin verificar',
    )
  })

  it('an orderly stop is a final phase, not an alert', () => {
    show(envelope('stopped_orderly'))
    const status = screen.getByTestId('session-status')
    expect(status).toHaveAttribute('data-phase', 'STOPPED')
    expect(within(status).queryByTestId('halt-reason')).toBeNull()
  })

  it('has no control: the page only reads', () => {
    show(envelope('operating_threshold_hypothesis'))
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('SessionBlocksView reads the gateway route', () => {
  it('asks the read-only route and shows what it answers', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ state: 'invalid', reason: 'not_json' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<SessionBlocksView />)
    await waitFor(() =>
      expect(screen.getByText('Archivo no utilizable')).toBeInTheDocument(),
    )
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit | undefined,
    ]
    expect(url).toBe('/api-live/paper-session/blocks')
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('a failed read is an error, not an empty session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    )
    render(<SessionBlocksView />)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500'),
    )
    expect(screen.queryByTestId('session-status')).toBeNull()
  })
})
