import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import operating from '../../../../docs/mission-control/b3/lectura-servidor-operando-187.json'
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
})
