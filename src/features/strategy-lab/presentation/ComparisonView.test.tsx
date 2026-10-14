import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { OPERATIONAL_LABELS } from '../domain/strategy-labels.ts'
import ComparisonView from './ComparisonView.tsx'
import InventoryView from './InventoryView.tsx'
import { exampleInventory, exampleRow } from '../testing/inventory-fixture.ts'
import type { KronosActivity } from '../infrastructure/kronos-activity.ts'
import type { Inventory, StrategyApi } from '../infrastructure/strategy-api.ts'

// DATOS DE EJEMPLO: estados y cifras sintéticos de pruebas, nunca de la app.
const inventory: Inventory = {
  ...exampleInventory,
  strategies: [
    ...exampleInventory.strategies,
    exampleRow({
      id: 'x6',
      name: 'X6 Carry',
      kind: 'carry',
      no_backtest: true,
      frozen: false,
      operational: {
        state: 'unverified',
        basis: 'registry',
        since_ms: null,
        reason: null,
      },
      research: {
        state: 'registry_note',
        evidence_of_edge: false,
        investigating: false,
        backtest: null,
        text: 'Nota del registro de ejemplo',
      },
    }),
  ],
}

const api = (): StrategyApi =>
  ({
    mode: 'registry',
    inventory: () => Promise.resolve(inventory),
  }) as unknown as StrategyApi

const unverified = () =>
  Promise.resolve({ verified: false as const, reason: 'scores_off' })

function renderView(
  onOpen = vi.fn(),
  onBack = vi.fn(),
  loadActivity: () => Promise<KronosActivity> = unverified,
) {
  render(
    <ComparisonView
      loadActivity={loadActivity}
      api={api()}
      connectError={null}
      reload={0}
      onOpen={onOpen}
      onBack={onBack}
    />,
  )
  return { onOpen, onBack }
}

describe('ComparisonView (datos de ejemplo)', () => {
  it('keeps one separate book per experiment and no consolidated figure', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    expect(screen.getAllByTestId('experiment-card')).toHaveLength(6)
    expect(screen.getByRole('note')).toHaveTextContent('no se suman')
    expect(screen.getByRole('note')).toHaveTextContent(
      'No hay cartera consolidada',
    )
    expect(document.body.textContent).not.toMatch(/Abrir en Terminal/)
    expect(document.body.textContent).not.toMatch(/descartad/i)
    expect(document.body.textContent).not.toMatch(/consolidado:/i)
  })

  it('says forward results are B5 and never declares profitability', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    for (const card of screen.getAllByTestId('experiment-card'))
      expect(card).toHaveTextContent('No disponible (B5)')
    expect(document.body.textContent).not.toMatch(/rentable/i)
  })

  it('uses the same badges as the inventory and keeps carry unverified', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    const card = (id: string) =>
      document.querySelector(`[data-id="${id}"]`) as HTMLElement
    expect(within(card('x1')).getByTestId('research-badge')).toHaveTextContent(
      'Candidata, no fiable',
    )
    expect(
      within(card('x1')).getByTestId('operational-badge'),
    ).toHaveTextContent(OPERATIONAL_LABELS.active)
    expect(
      within(card('x4')).getByTestId('operational-badge'),
    ).toHaveTextContent('Estado no verificado')
    expect(
      within(card('x6')).getByTestId('operational-badge'),
    ).toHaveTextContent('Estado no verificado')
    expect(card('x6')).toHaveTextContent('Nota del registro de ejemplo')
    expect(
      within(card('x5')).getByTestId('operational-badge'),
    ).toHaveTextContent('Cerrada')
  })

  it('opens the detail of an experiment and goes back to the inventory', async () => {
    const { onOpen, onBack } = renderView()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Detalle de X1 Candidata' }),
    )
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'x1' }))
    await userEvent.click(
      screen.getByRole('button', { name: '← Volver al inventario' }),
    )
    expect(onBack).toHaveBeenCalled()
  })

  it('shows Kronos as verified only with a verified activity read', async () => {
    renderView(vi.fn(), vi.fn(), () =>
      Promise.resolve({
        verified: true as const,
        updated_ms: Date.UTC(2026, 9, 14, 10, 30),
        trades: 4,
        decisions: 30,
      }),
    )
    await screen.findAllByTestId('experiment-card')
    const card = document.querySelector('[data-id="x4"]') as HTMLElement
    expect(
      await within(card).findByTestId('kronos-verified'),
    ).toHaveTextContent('Actividad verificada')
    expect(within(card).getByTestId('kronos-activity')).toHaveTextContent(
      '2026-10-14 10:30 UTC',
    )
    expect(screen.getAllByText('Actividad verificada')).toHaveLength(1)
  })

  it('keeps Kronos «Estado no verificado» when the activity is not verified', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    const card = document.querySelector('[data-id="x4"]') as HTMLElement
    expect(within(card).queryByTestId('kronos-verified')).toBeNull()
    expect(within(card).getByTestId('kronos-activity')).toHaveTextContent(
      'Estado no verificado',
    )
    expect(document.body.textContent).not.toMatch(/Actividad verificada/)
  })

  it('shows the unit only where the result is computed that way and adds no arms', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    const rows = screen.getAllByRole('row').slice(1)
    const x1 = rows.find((r) => r.textContent?.includes('X1 Candidata'))!
    const x4 = rows.find((r) => r.textContent?.includes('X4 Modelo'))!
    expect(x1).toHaveTextContent('pb por operación (neto)')
    expect(x4).toHaveTextContent('No disponible')
    expect(x4).not.toHaveTextContent('pb por operación')
    expect(document.body.textContent).not.toMatch(/Brazo/i)
  })

  it('shows the failure instead of example data', async () => {
    render(
      <ComparisonView
        api={
          {
            mode: 'registry',
            inventory: () => Promise.reject(new Error('HTTP 502')),
          } as unknown as StrategyApi
        }
        connectError={null}
        reload={0}
        onOpen={() => {}}
        onBack={() => {}}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502')
  })
})

describe('Ver comparación', () => {
  it('is offered by the inventory', async () => {
    const onCompare = vi.fn()
    render(
      <InventoryView
        api={api()}
        connectError={null}
        reload={0}
        onOpen={() => {}}
        onCompare={onCompare}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Ver comparación' }),
    )
    expect(onCompare).toHaveBeenCalled()
  })
})
