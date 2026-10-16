import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import lastFailed from '../../../../docs/mission-control/b3/lectura-servidor-ultima-publicacion-fallida-187.json'
import operating from '../../../../docs/mission-control/b3/lectura-servidor-operando-187.json'
import restartFailed from '../../../../docs/mission-control/b3/lectura-servidor-reinicio-fallido-187.json'
import restartPublished from '../../../../docs/mission-control/b3/lectura-servidor-reinicio-publicado-187.json'
import stopped from '../../../../docs/mission-control/b3/lectura-servidor-detenida-187.json'
import { decodeSessionBlocksReading } from '../infrastructure/session-blocks-api.ts'
import { SessionBlocksReadingView } from './SessionBlocksView.tsx'

// The chain of #187-05 (option A), every hop on invented data: a real Supervisor wrote the files
// (python/tests/session_e2e_187.py) → the server reader read them (session-blocks-reader.test.ts keeps
// these two snapshots in step) → the client decodes the route answer → the page shows it.
const PILL = { selector: '.mc-pill' }

describe('real Supervisor → server reader → client decoder → page (synthetic session)', () => {
  it('operation: the page shows a running session that nobody confirmed', () => {
    const reading = decodeSessionBlocksReading(operating)
    expect(reading.state).toBe('ok')
    render(<SessionBlocksReadingView reading={reading} />)
    const status = screen.getByTestId('session-status')
    expect(status).toHaveAttribute('data-phase', 'LIVE')
    expect(screen.getByText(/en marcha, sin confirmar/i, PILL)).toHaveAttribute(
      'data-tone',
      'nodata',
    )
    expect(status.textContent).not.toMatch(/vigente|viva\b|al día/i)
    expect(screen.getByTestId('document-age')).toHaveTextContent('hace 2 s')
    expect(
      within(screen.getByTestId('session-validity')).getByText(
        /Vigencia no determinada/,
      ),
    ).toBeInTheDocument()
  })

  it('stop: the page shows the orderly stop as final', () => {
    render(
      <SessionBlocksReadingView
        reading={decodeSessionBlocksReading(stopped)}
      />,
    )
    const status = screen.getByTestId('session-status')
    expect(status).toHaveAttribute('data-phase', 'STOPPED')
    expect(within(status).getByText('Sesión terminada')).toBeInTheDocument()
  })

  it('operator restart that publishes: the page shows the new run', () => {
    render(
      <SessionBlocksReadingView
        reading={decodeSessionBlocksReading(restartPublished)}
      />,
    )
    expect(screen.getByTestId('session-status')).toBeInTheDocument()
  })

  it('operator restart whose publication failed: the page refuses the cut run’s file', () => {
    render(
      <SessionBlocksReadingView
        reading={decodeSessionBlocksReading(restartFailed)}
      />,
    )
    expect(screen.getByText('Archivo no utilizable')).toBeInTheDocument()
    expect(screen.getByText(/otra corrida/)).toBeInTheDocument()
    expect(screen.queryByTestId('session-status')).toBeNull()
  })

  it('last publication failed: the page does not present the old file as the running session', () => {
    render(
      <SessionBlocksReadingView
        reading={decodeSessionBlocksReading(lastFailed)}
      />,
    )
    const status = screen.getByTestId('session-status')
    expect(status.textContent).not.toMatch(/en marcha|vigente|viva\b|al día/i)
    expect(screen.getByTestId('status-gateway-reason')).toHaveTextContent(
      /no es el estado actual/,
    )
    expect(
      within(screen.getByTestId('session-validity')).queryByText(/fresca/i),
    ).toBeNull()
  })
})
