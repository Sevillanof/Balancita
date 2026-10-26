// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalDecisions from './TerminalDecisions.tsx'
import type { DecisionRow } from './terminal-decisions.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const rows: DecisionRow[] = [
  {
    id: 'long',
    action: 'LONG',
    strategy: 'Prueba',
    reason: 'Entrada de prueba',
    time: '10:00',
  },
  ...['wait-a', 'wait-b'].map((id) => ({
    id,
    action: 'WAIT',
    strategy: 'Prueba',
    reason: 'Espera de prueba',
    time: '09:45',
  })),
  {
    id: 'short',
    action: 'SHORT',
    strategy: 'Prueba',
    reason: 'Salida de prueba',
    time: '09:30',
  },
]

describe('Terminal decision presentation', () => {
  it.each([false, true])(
    'filters, selects and preserves details when embedded=%s',
    (embedded) => {
      const onSelect = vi.fn()
      render(
        <TerminalDecisions
          embedded={embedded}
          rows={rows}
          selectedId="long"
          onSelect={onSelect}
          selected={<p>Detalle seleccionado</p>}
        >
          <p>Efectos durables</p>
        </TerminalDecisions>,
      )
      const list = screen.getByRole('list', { name: 'Lista de decisiones' })
      expect(within(list).getAllByRole('listitem')).toHaveLength(3)
      expect(within(list).getByText(/WAIT ×2/)).toBeTruthy()
      expect(
        screen
          .getByRole('button', { name: 'Seleccionar análisis long' })
          .getAttribute('aria-pressed'),
      ).toBe('true')

      fireEvent.click(screen.getByRole('button', { name: 'Señales' }))
      expect(within(list).getAllByRole('listitem')).toHaveLength(2)
      expect(within(list).queryByText(/WAIT/)).toBeNull()
      fireEvent.click(
        within(list).getByRole('button', {
          name: 'Seleccionar análisis short',
        }),
      )
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('short')
      expect(screen.getByText('Detalle seleccionado')).toBeTruthy()
      expect(screen.getByText('Efectos durables')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Todas' }))
      expect(within(list).getByText(/WAIT ×2/)).toBeTruthy()
    },
  )

  it('keeps health warnings above an existing list', () => {
    render(
      <TerminalDecisions
        rows={rows}
        selectedId=""
        onSelect={() => {}}
        health="Operador sin latido"
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Operador sin latido')
    expect(
      screen.getByRole('list', { name: 'Lista de decisiones' }),
    ).toBeTruthy()
  })

  it('replaces rows and filters with a notice', () => {
    render(
      <TerminalDecisions
        rows={rows}
        selectedId=""
        onSelect={() => {}}
        notice="Motor no disponible"
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Motor no disponible')
    expect(screen.queryByRole('list')).toBeNull()
    expect(
      screen.queryByRole('group', { name: 'Filtro de decisiones' }),
    ).toBeNull()
  })

  it('shows the empty state without a filter', () => {
    render(<TerminalDecisions rows={[]} selectedId="" onSelect={() => {}} />)
    expect(screen.getByText('Aún no hay análisis registrados.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(
      screen.queryByRole('group', { name: 'Filtro de decisiones' }),
    ).toBeNull()
  })

  it('shows an empty signals list without losing the all filter', () => {
    render(
      <TerminalDecisions
        rows={rows.filter((row) => row.action === 'WAIT')}
        selectedId=""
        onSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Señales' }))
    expect(screen.getByText('No hay señales todavía.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Todas' }))
    expect(screen.getByText(/WAIT ×2/)).toBeTruthy()
  })

  it('scrolls only its list when an external selection is outside the viewport', () => {
    const { rerender } = render(
      <TerminalDecisions rows={rows} selectedId="long" onSelect={() => {}} />,
    )
    const list = screen.getByRole('list', { name: 'Lista de decisiones' })
    const short = screen.getByRole('button', {
      name: 'Seleccionar análisis short',
    })
    const long = screen.getByRole('button', {
      name: 'Seleccionar análisis long',
    })
    const pageScroll = vi.spyOn(window, 'scrollTo')
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 100, 500, 120),
    )
    vi.spyOn(short, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 240, 500, 60),
    )
    vi.spyOn(long, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 80, 500, 40),
    )
    expect(list.scrollTop).toBe(0)
    rerender(
      <TerminalDecisions rows={rows} selectedId="short" onSelect={() => {}} />,
    )
    expect(list.scrollTop).toBe(80)
    rerender(
      <TerminalDecisions rows={rows} selectedId="long" onSelect={() => {}} />,
    )
    expect(list.scrollTop).toBe(60)
    expect(pageScroll).not.toHaveBeenCalled()
  })
})
