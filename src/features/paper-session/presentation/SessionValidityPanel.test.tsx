import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { decodePositionsBlock } from '../domain/session-blocks.ts'
import { positionsBlock, position, verification } from '../testing/fixtures.ts'
import SessionValidityPanel from './SessionValidityPanel.tsx'

const PILL = { selector: '.mc-pill' }

// Every block here is SYNTHETIC (testing/fixtures.ts): no capture, no session.
const show = (raw: unknown) => {
  render(<SessionValidityPanel block={decodePositionsBlock(raw)} />)
  return screen.getByTestId('session-validity')
}

/** What the gateway adds when it degrades (server/.../session-validity.ts). */
const withGateway = (
  raw: Record<string, unknown>,
  gateway: Record<string, unknown>,
) => ({ ...raw, gateway })

describe('operational scenario', () => {
  it('shows current operation only with an approved limit, a fresh report and a verified position', () => {
    const view = show(
      withGateway(verification.approvedFresh(), {
        age_ms: 30_000,
        reason: null,
      }),
    )
    expect(view).toHaveAttribute('data-current', 'true')
    expect(screen.getByText('Vigente', PILL)).toBeInTheDocument()
    expect(within(view).getByText('Verificada')).toBeInTheDocument()
    expect(within(view).getByText('1.25')).toBeInTheDocument()
    expect(within(view).queryByText(/Cifras no vigentes/)).toBeNull()
    expect(within(view).queryByTestId('gateway-reason')).toBeNull()
  })

  it('a position the publisher did not verify is not shown as verified even when current', () => {
    const view = show(
      positionsBlock(
        { thresholds: { report_max_age_ms: 60_000, status: 'approved' } },
        [position({ verified: false, stop_protection: null })],
      ),
    )
    expect(within(view).getByText('No verificada')).toBeInTheDocument()
    expect(within(view).queryByText('Verificada')).toBeNull()
  })
})

describe('degraded scenarios', () => {
  it('gateway: report older than its limit is «Desactualizado», figures not current, never «Verificada»', () => {
    const view = show(
      withGateway(
        {
          ...verification.approvedFresh(),
          verification: {
            verified: true,
            reasons: [],
            freshness: 'stale',
            thresholds: { report_max_age_ms: 60_000, status: 'approved' },
          },
        },
        { age_ms: 61_000, reason: 'report_age_over_limit' },
      ),
    )
    expect(view).toHaveAttribute('data-current', 'false')
    expect(screen.getByText('Desactualizado', PILL)).toBeInTheDocument()
    expect(
      within(view).getByText('No vigente', { selector: 'span.mc-pill' }),
    ).toBeInTheDocument()
    expect(within(view).queryByText('Verificada')).toBeNull()
    expect(within(view).getByRole('note')).toHaveTextContent(/no vigentes/)
    expect(within(view).queryByText('1.25')).toBeNull()
    expect(within(view).getByTestId('gateway-reason')).toHaveTextContent(
      'Reporte más viejo que su límite · edad 61 s',
    )
  })

  it('publisher: report_stale is «Desactualizado» and keeps its reason', () => {
    const view = show(verification.approvedStale())
    expect(screen.getByText('Desactualizado', PILL)).toBeInTheDocument()
    expect(within(view).getByText('Reporte vencido')).toBeInTheDocument()
  })

  it('no approved limit: «Vigencia no determinada: umbral no aprobado», nodata, no operation tone', () => {
    const view = show(verification.notApproved())
    expect(view).toHaveAttribute('data-current', 'false')
    expect(
      within(view).getByText(/Vigencia no determinada: umbral no aprobado/),
    ).toBeInTheDocument()
    const pills = view.ownerDocument.querySelectorAll('.mc-pill')
    expect(pills.length).toBeGreaterThan(0)
    expect(
      Array.from(pills).some((el) => el.getAttribute('data-tone') === 'ok'),
    ).toBe(false)
    expect(screen.queryByText('Vigente', PILL)).toBeNull()
  })

  it('a hypothetical limit is not an approval, even if a block claimed fresh and verified (defensive)', () => {
    const view = show(verification.hypothesisPromoted())
    expect(view).toHaveAttribute('data-current', 'false')
    expect(within(view).queryByText('Verificada')).toBeNull()
    expect(screen.queryByText('Vigente', PILL)).toBeNull()
    expect(
      within(view).getByText(/Límite de vigencia en hipótesis: sin aprobar/),
    ).toBeInTheDocument()
  })

  it('gateway could not measure the age: unknown, and says why', () => {
    const view = show(
      withGateway(
        {
          ...verification.approvedFresh(),
          verification: {
            verified: true,
            reasons: [],
            freshness: 'unknown',
            thresholds: { report_max_age_ms: 60_000, status: 'approved' },
          },
        },
        { age_ms: null, reason: 'report_age_unknown' },
      ),
    )
    expect(view).toHaveAttribute('data-current', 'false')
    expect(within(view).queryByText('Verificada')).toBeNull()
    expect(within(view).getByTestId('gateway-reason')).toHaveTextContent(
      'Edad del reporte no medible',
    )
  })

  it('source_stale: reason shown and the position not verified', () => {
    const view = show(verification.sourceStale())
    expect(within(view).getByText('Fuente desactualizada')).toBeInTheDocument()
    expect(within(view).getByText('No verificada')).toBeInTheDocument()
  })

  it('never invents a phase or a running state', () => {
    for (const raw of [
      verification.approvedFresh(),
      verification.notApproved(),
      verification.approvedStale(),
    ]) {
      const view = show(raw)
      expect(view.textContent).not.toMatch(
        /en marcha|ejecución activa|LIVE|WARMING|Motor paper/i,
      )
      document.body.innerHTML = ''
    }
  })

  it('an empty report says so instead of showing zero', () => {
    const view = show(positionsBlock({}, []))
    expect(
      within(view).getByText('Sin posiciones abiertas en el reporte.'),
    ).toBeInTheDocument()
  })
})

describe('simulated account (BAL-DECISION-185-CARTERA-SIMULADA-02)', () => {
  const current = () =>
    positionsBlock({
      thresholds: { report_max_age_ms: 60_000, status: 'approved' },
    })

  it('shows total, definitive, committed and free with unambiguous names, as published', () => {
    const view = show(current())
    const account = within(view).getByTestId('session-account')
    expect(
      within(account).getByText('Saldo total simulado'),
    ).toBeInTheDocument()
    expect(within(account).getByText('1012.50')).toBeInTheDocument()
    expect(within(account).getByText('Capital definitivo')).toBeInTheDocument()
    expect(within(account).getByText('1010.00')).toBeInTheDocument()
    expect(
      within(account).getByText('Comprometido por posiciones abiertas'),
    ).toBeInTheDocument()
    expect(within(account).getByText('321.50')).toBeInTheDocument()
    expect(within(account).getByText('Libre para operar')).toBeInTheDocument()
    expect(within(account).getByText('688.50')).toBeInTheDocument()
  })

  it('pending orders are shown as pending without reservation, never as committed', () => {
    const account = within(show(current())).getByTestId('session-account')
    expect(
      within(account).getByText(/Órdenes pendientes: 2 · sin reserva/),
    ).toBeInTheDocument()
  })

  it('a provisional gain is named as such and the free amount says it comes from the definitive capital', () => {
    const account = within(show(current())).getByTestId('session-account')
    expect(
      within(account).getByText(
        /Sin ganancias no verificadas \(2.50 provisionales\)/,
      ),
    ).toBeInTheDocument()
    expect(
      within(account).getByText('Capital definitivo menos comprometido'),
    ).toBeInTheDocument()
  })

  it('when the report is not current no figure is presented as current', () => {
    const account = within(show(verification.hypothesisStale())).getByTestId(
      'session-account',
    )
    expect(within(account).getAllByText('No vigente')).toHaveLength(4)
    expect(within(account).queryByText('688.50')).toBeNull()
  })

  it('a file that predates the field shows no account instead of inventing one', () => {
    const { account: _omit, ...old } = current() as Record<string, unknown>
    void _omit
    const view = show(old)
    expect(within(view).queryByTestId('session-account')).toBeNull()
  })

  it('refuses an account that claims a reservation for pending orders', () => {
    const raw = current() as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(() =>
      decodePositionsBlock({
        ...raw,
        account: { ...raw.account, pending_reservation: 'reserved' },
      }),
    ).toThrow()
  })
})
