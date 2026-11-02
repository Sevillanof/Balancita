// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExigenciaControl from './ExigenciaControl.tsx'
import { EXIGENCIA_PAPER_LEVELS } from './exigencia-levels.ts'

afterEach(cleanup)

describe('Exigencia: posiciones y experto rebotes', () => {
  it('asks for up to 3 positions and the rebound expert as options of the same modal', () => {
    const change = vi.fn()
    render(
      <ExigenciaControl value={EXIGENCIA_PAPER_LEVELS} onChange={change} />,
    )
    expect(screen.queryByTestId('posiciones-detalle')).toBeNull()
    fireEvent.click(screen.getByLabelText('Hasta 3'))
    expect(change).toHaveBeenLastCalledWith({
      ...EXIGENCIA_PAPER_LEVELS,
      posiciones: 3,
    })
    fireEvent.click(screen.getByLabelText('Encendido'))
    expect(change).toHaveBeenLastCalledWith({
      ...EXIGENCIA_PAPER_LEVELS,
      rebotes: 'encendido',
    })
  })

  it('shows the closed visual detail only when something changes', () => {
    render(
      <ExigenciaControl
        value={{
          ...EXIGENCIA_PAPER_LEVELS,
          posiciones: 3,
          rebotes: 'encendido',
        }}
        onChange={() => undefined}
      />,
    )
    const detail = screen.getByTestId(
      'posiciones-detalle',
    ) as HTMLDetailsElement
    expect(detail.open).toBe(false)
    expect(detail.textContent).toContain('rebote')
  })
})
