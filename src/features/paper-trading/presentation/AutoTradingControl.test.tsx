import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AutoTradingControl from './AutoTradingControl.tsx'

describe('AutoTradingControl', () => {
  it('is an accessible opt-in switch and reports warmup while unavailable', () => {
    const onChange = vi.fn()
    render(
      <AutoTradingControl
        enabled={false}
        available={false}
        ready={false}
        onChange={onChange}
      />,
    )

    const toggle = screen.getByRole('switch', {
      name: 'Trading automático simulado',
    })
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/Indicadores en preparación/)).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('changes only after explicit opt-in when available', () => {
    const onChange = vi.fn()
    render(
      <AutoTradingControl
        enabled={false}
        available
        ready
        onChange={onChange}
      />,
    )
    fireEvent.click(
      screen.getByRole('switch', { name: 'Trading automático simulado' }),
    )
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
