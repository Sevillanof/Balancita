import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import AnalyzerModal from './AnalyzerModal.tsx'
import type {
  AnalyzerApi,
  AnalyzerResponse,
} from '../infrastructure/analyzer-api.ts'
import {
  fullAnalyzerData,
  smallAnalyzerData,
} from '../testing/analyzer-fixture.ts'

/* DATOS DE EJEMPLO: números inventados para estas pruebas. */
const apiOf = (response: AnalyzerResponse): AnalyzerApi => ({
  events: vi.fn(async () => response),
})
const small = () => apiOf({ available: true, data: smallAnalyzerData() })

const open = async (api: AnalyzerApi = small(), onClose = vi.fn()) => {
  render(<AnalyzerModal api={api} onClose={onClose} />)
  await screen.findByTestId('analyzer-summary')
  return onClose
}
const leverage = (name: string) =>
  within(screen.getByRole('group', { name: 'Apalancamiento' })).getByRole(
    'button',
    { name },
  )

describe('Analizador de señales', () => {
  it('muestra el aviso de hipótesis, el resumen y el detalle', async () => {
    await open()
    expect(
      screen.getByRole('dialog', { name: 'Analizador de señales' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/no una aprobación/)).toHaveTextContent(
      '2026-01-01 al 2026-04-19',
    )
    const summary = screen.getByTestId('analyzer-summary')
    expect(summary).toHaveTextContent('Con 1× y 100 USD')
    expect(summary).toHaveTextContent('1 de 3')
    expect(summary).toHaveTextContent('siguen positivas después de costes')
    expect(screen.getByTestId('detail-gross')).toHaveTextContent('+0,65 USD')
    expect(screen.getByTestId('detail-net')).toHaveTextContent('+0,21 USD')
    expect(screen.getByTestId('detail-direction')).toHaveTextContent('75 %')
    expect(screen.getByText(/unos 1\.000 USD/)).toBeInTheDocument()
  })

  it('al cambiar la entrada cambian los números', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: /^1\.?000$/ }))
    expect(screen.getByTestId('detail-net')).toHaveTextContent('+2,08 USD')
    expect(screen.getByTestId('analyzer-summary')).toHaveTextContent(
      /Con 1× y 1\.?000 USD/,
    )
  })

  it('con mucho apalancamiento marca y avisa de las liquidaciones', async () => {
    const user = userEvent.setup()
    await open()
    expect(screen.getByTestId('detail-liquidated')).toHaveTextContent('0')
    expect(screen.queryByTestId('detail-alert')).not.toBeInTheDocument()
    await user.click(leverage('20×'))
    expect(screen.getByTestId('detail-liquidated')).toHaveTextContent('1')
    expect(screen.getByTestId('detail-alert')).toHaveTextContent(
      'se pierde toda la entrada',
    )
    const cell = screen.getByRole('button', {
      name: /BTC · movimiento 5 min · seguir · 5 min.*1 liquidadas/,
    })
    expect(cell).toHaveTextContent('⚠ 1')
  })

  it('el selector Ver cambia el número grande de la celda, el otro queda chico', async () => {
    const user = userEvent.setup()
    await open()
    const cell = () =>
      screen.getByRole('button', {
        name: /BTC · movimiento 5 min · seguir · 5 min/,
      })
    expect(cell()).toHaveTextContent('+0,65 USD')
    expect(cell()).toHaveTextContent('neto +0,21 USD')
    await user.selectOptions(screen.getByLabelText('Ver'), 'net')
    expect(cell()).toHaveTextContent('bruto +0,65 USD')
  })

  it('elegir otra celda cambia el detalle', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(
      screen.getByRole('button', {
        name: /BTC · movimiento 5 min · revertir · 5 min/,
      }),
    )
    expect(
      screen.getByRole('region', { name: 'Detalle de la combinación' }),
    ).toHaveTextContent('BTC · movimiento 5 min · revertir')
  })

  it('dibuja las 78 combinaciones del fixture completo', async () => {
    await open(apiOf({ available: true, data: fullAnalyzerData() }))
    expect(screen.getByTestId('analyzer-summary')).toHaveTextContent('de 78')
    const grid = screen.getByRole('table')
    expect(within(grid).getAllByRole('button')).toHaveLength(78)
  })

  it('avisa del funding incompleto', async () => {
    const data = { ...smallAnalyzerData(), funding_complete: false }
    await open(apiOf({ available: true, data }))
    expect(screen.getByText(/funding está incompleto/)).toBeInTheDocument()
  })

  it('cuando no está disponible, muestra el motivo y el comando', async () => {
    render(
      <AnalyzerModal
        api={apiOf({
          available: false,
          reason: 'Todavía no se generó el estudio.',
          command: 'python -m analyzer export',
        })}
        onClose={vi.fn()}
      />,
    )
    expect(
      await screen.findByText('Todavía no se generó el estudio.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Comando')).toHaveTextContent(
      'python -m analyzer export',
    )
  })

  it('si falla la lectura, lo dice y deja reintentar', async () => {
    const user = userEvent.setup()
    const events = vi
      .fn<AnalyzerApi['events']>()
      .mockRejectedValueOnce(new Error('sin conexión'))
      .mockResolvedValue({ available: true, data: smallAnalyzerData() })
    render(<AnalyzerModal api={{ events }} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('sin conexión')
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByTestId('analyzer-summary')).toBeInTheDocument()
  })

  it('Escape cierra y el foco empieza en Cerrar', async () => {
    const user = userEvent.setup()
    const onClose = await open()
    expect(screen.getByRole('button', { name: 'Cerrar' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})
