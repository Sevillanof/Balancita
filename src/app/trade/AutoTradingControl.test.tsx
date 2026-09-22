import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AutoTradingControl from './AutoTradingControl'

describe('AutoTradingControl', () => {
  it('is presentation only: disabled with no active handler', () => {
    render(<AutoTradingControl />)

    const button = screen.getByRole('button', { name: /Auto/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toHaveAttribute('aria-pressed', 'true')
  })

  it('states that it executes no action in this phase', () => {
    render(<AutoTradingControl />)

    expect(screen.getByText(/No ejecuta ninguna acción/i)).toBeInTheDocument()
  })
})
