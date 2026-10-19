import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ForwardHealth } from '../infrastructure/strategy-api.ts'
import { FundingChips } from './FundingChips.tsx'

// DATOS DE EJEMPLO: cifras sintéticas de pruebas, nunca de la app.
const NOW = 1_800_000_000_000
const funding: ForwardHealth['funding'] = {
  PF_XBTUSD: { usable: true, code: 'ok', reason: '', checked_ms: NOW - 60_000 },
  PF_ETHUSD: {
    usable: false,
    code: 'stale',
    reason: 'la hora 07:00 no llegó: 5 min por encima del límite de 71 min',
    checked_ms: NOW - 120_000,
  },
}

describe('FundingChips: funding por producto en el área de salud de la cabecera', () => {
  it('draws one compact chip per product, green with a tick when usable and amber with a cross when not', () => {
    render(<FundingChips funding={funding} now={NOW} />)
    const ok = screen.getByTestId('funding-chip-PF_XBTUSD')
    expect(ok).toHaveTextContent('XBT ✓')
    expect(ok).toHaveAttribute('data-tone', 'ok')
    expect(ok).toHaveAttribute('aria-label', 'PF_XBTUSD: funding usable')
    const bad = screen.getByTestId('funding-chip-PF_ETHUSD')
    expect(bad).toHaveTextContent('ETH ✕')
    expect(bad).not.toHaveAttribute('data-tone')
    expect(bad).toHaveAttribute(
      'title',
      'PF_ETHUSD: funding no usable: la última tasa horaria de funding no quedó guardada a tiempo (la captura estuvo parada o sin conexión) (comprobado hace 2 min). Detalle: la hora 07:00 no llegó: 5 min por encima del límite de 71 min',
    )
    expect(
      screen.getByRole('group', { name: 'Funding por producto' }),
    ).toBeInTheDocument()
  })

  it('draws nothing until the page has read the inventory', () => {
    render(<FundingChips funding={undefined} now={NOW} />)
    expect(screen.queryByTestId('funding-chips')).toBeNull()
  })

  it('says there is no data instead of showing a green chip', () => {
    render(<FundingChips funding={null} now={NOW} />)
    expect(screen.getByTestId('funding-chips')).toHaveTextContent('sin datos')
    expect(screen.queryByText(/✓/)).toBeNull()
  })
})
