import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import InventoryView from './InventoryView.tsx'
import {
  OPERATIONAL_LABELS,
  RESEARCH_LABELS,
  operationalLabel,
  researchLabel,
} from '../domain/strategy-labels.ts'
import { exampleInventory } from '../testing/inventory-fixture.ts'
import type { StrategyApi } from '../infrastructure/strategy-api.ts'

const api = (inventory: StrategyApi['inventory']): StrategyApi =>
  ({ mode: 'registry', inventory }) as StrategyApi

const row = (name: string) =>
  screen.getByText(name).closest('tr') as HTMLElement

describe('InventoryView (datos de ejemplo)', () => {
  it('separates operational and research state with the shared labels', async () => {
    render(
      <InventoryView
        api={api(() => Promise.resolve(exampleInventory))}
        connectError={null}
        reload={0}
        onOpen={() => {}}
      />,
    )
    await screen.findByText('X1 Candidata')
    const x2 = within(row('X2 Sin ventaja'))
    expect(x2.getByTestId('operational-badge')).toHaveTextContent(
      OPERATIONAL_LABELS.active,
    )
    expect(x2.getByTestId('research-badge')).toHaveTextContent(
      RESEARCH_LABELS.no_edge,
    )
    expect(x2.getByTestId('frozen-badge')).toBeInTheDocument()
    // Only a candidate verdict is shown as evidence of an edge, and not as reliable.
    expect(
      within(row('X1 Candidata')).getByTestId('research-badge'),
    ).toHaveTextContent('Candidata, no fiable')
    expect(row('X1 Candidata')).toHaveTextContent('+58,24 pb/op')
    expect(row('X1 Candidata')).toHaveTextContent('t = 1,58')
    expect(row('X1 Candidata')).toHaveTextContent(
      'Elegida entre 1.000 configuraciones',
    )
  })

  it('never invents forward or model numbers', async () => {
    render(
      <InventoryView
        api={api(() => Promise.resolve(exampleInventory))}
        connectError={null}
        reload={0}
        onOpen={() => {}}
      />,
    )
    await screen.findByText('X3 Modelo de Qwen')
    const qwen = row('X3 Modelo de Qwen')
    expect(qwen).toHaveTextContent('Sin backtest')
    expect(qwen).toHaveTextContent('No disponible')
    expect(qwen).toHaveTextContent('forward: B5')
    expect(qwen).toHaveTextContent('Qwen decide la salida')
    expect(
      within(row('X4 Modelo sin registro')).getByTestId('operational-badge'),
    ).toHaveTextContent('Estado no verificado')
  })

  it('filters by operational and research state', async () => {
    render(
      <InventoryView
        api={api(() => Promise.resolve(exampleInventory))}
        connectError={null}
        reload={0}
        onOpen={() => {}}
      />,
    )
    await screen.findByText('X5 Cerrada')
    await userEvent.click(screen.getByRole('button', { name: /Cerradas/ }))
    expect(screen.getAllByTestId('inventory-row')).toHaveLength(1)
    await userEvent.click(
      screen.getByRole('button', { name: /Con evidencia de ventaja/ }),
    )
    expect(screen.getAllByTestId('inventory-row')).toHaveLength(1)
    expect(screen.getByText('X1 Candidata')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Activas/ }))
    expect(screen.getAllByTestId('inventory-row')).toHaveLength(3)
  })

  it('audits a closed strategy in place and opens the detail of the others', async () => {
    const onOpen = vi.fn()
    render(
      <InventoryView
        api={api(() => Promise.resolve(exampleInventory))}
        connectError={null}
        reload={0}
        onOpen={onOpen}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Auditar X5 Cerrada' }),
    )
    expect(screen.getByTestId('inventory-audit')).toHaveTextContent(
      'closed_with_engine_d',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Detalle de X1 Candidata' }),
    )
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'x1' }))
    expect(
      screen.getByRole('button', { name: 'Detalle de X3 Modelo de Qwen' }),
    ).toBeDisabled()
  })

  it('shows the failure instead of example data', async () => {
    render(
      <InventoryView
        api={api(() => Promise.reject(new Error('HTTP 502')))}
        connectError={null}
        reload={0}
        onOpen={() => {}}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502')
  })

  it('says it is unavailable when the source has no inventory', () => {
    render(
      <InventoryView
        api={api(undefined)}
        connectError={null}
        reload={0}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('No disponible')
  })
})

describe('strategy labels', () => {
  it('falls back to the unverified and unmeasured words for unknown values', () => {
    expect(operationalLabel('whatever')).toBe('Estado no verificado')
    expect(researchLabel('whatever')).toBe('Sin evaluación comparable')
  })
})
