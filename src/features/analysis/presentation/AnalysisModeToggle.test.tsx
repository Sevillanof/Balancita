import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AnalysisModeToggle } from './AnalysisModeToggle.tsx'

describe('AnalysisModeToggle', () => {
  it('reflects the current mode and reports an off -> on change', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AnalysisModeToggle mode="local" onChange={onChange} />)

    const toggle = screen.getByRole('switch', { name: /análisis con ia/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Desactivado')).toBeInTheDocument()

    await user.click(toggle)
    expect(onChange).toHaveBeenCalledWith('ai')
  })

  it('reports an on -> off change', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AnalysisModeToggle mode="ai" onChange={onChange} />)

    const toggle = screen.getByRole('switch', { name: /análisis con ia/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Activado')).toBeInTheDocument()

    await user.click(toggle)
    expect(onChange).toHaveBeenCalledWith('local')
  })

  it('is disabled and inert when no AI backend is available', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AnalysisModeToggle mode="local" disabled onChange={onChange} />)

    const toggle = screen.getByRole('switch', { name: /análisis con ia/i })
    expect(toggle).toBeDisabled()

    await user.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })
})
