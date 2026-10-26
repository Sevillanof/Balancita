import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ModalFrame from './ModalFrame.tsx'

describe('Strategy modal frame', () => {
  it.each([{}, { wide: true }, { xwide: true }, { wide: true, xwide: true }])(
    'preserves its accessible dialog contract with sizes %j',
    (size) => {
      render(
        <ModalFrame label="Prueba de diálogo" onClose={() => {}} {...size}>
          <h2>Contenido del diálogo</h2>
          <p>Información de prueba</p>
        </ModalFrame>,
      )
      const dialog = screen.getByRole('dialog', { name: 'Prueba de diálogo' })
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      expect(dialog).toHaveTextContent('Información de prueba')
    },
  )

  it('closes on Escape, but not on other keys, and removes its listener on unmount', async () => {
    const close = vi.fn()
    const user = userEvent.setup()
    const { unmount } = render(
      <ModalFrame label="Prueba" onClose={close}>
        <button type="button">Interior</button>
      </ModalFrame>,
    )
    await user.keyboard('{Enter}')
    expect(close).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(close).toHaveBeenCalledTimes(1)
    unmount()
    await user.keyboard('{Escape}')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes only when the backdrop itself receives the mouse event', () => {
    const close = vi.fn()
    render(
      <ModalFrame label="Prueba" onClose={close}>
        <button type="button">Interior</button>
      </ModalFrame>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Prueba' })
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Interior' }))
    fireEvent.mouseDown(dialog)
    expect(close).not.toHaveBeenCalled()
    expect(dialog.parentElement).not.toBeNull()
    fireEvent.mouseDown(dialog.parentElement!)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uses the current dismissal callback after rerender', async () => {
    const first = vi.fn()
    const next = vi.fn()
    const { rerender } = render(
      <ModalFrame label="Prueba" onClose={first}>
        Contenido
      </ModalFrame>,
    )
    rerender(
      <ModalFrame label="Prueba" onClose={next}>
        Contenido
      </ModalFrame>,
    )
    await userEvent.setup().keyboard('{Escape}')
    expect(first).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledExactlyOnceWith()
  })
})
