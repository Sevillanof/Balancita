import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPERATIONAL_LABELS } from '../domain/strategy-labels.ts'
import ComparisonView from './ComparisonView.tsx'
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
  onNew = vi.fn(),
  loadActivity: () => Promise<KronosActivity> = unverified,
) {
  render(
    <ComparisonView
      loadActivity={loadActivity}
      api={api()}
      connectError={null}
      reload={0}
      onOpen={onOpen}
      onNew={onNew}
    />,
  )
  return { onOpen, onNew }
}

describe('ComparisonView (datos de ejemplo)', () => {
  it('keeps one separate book per experiment and no consolidated figure', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    expect(screen.getAllByTestId('experiment-card')).toHaveLength(5)
    expect(screen.getByRole('note')).toHaveTextContent('no se suman')
    expect(screen.getByRole('note')).toHaveTextContent(
      'No hay cartera consolidada',
    )
    expect(document.body.textContent).not.toMatch(/Abrir en Terminal/)
    expect(document.body.textContent).not.toMatch(/descartad/i)
    expect(document.body.textContent).not.toMatch(/consolidado:/i)
  })

  it('says why there is no forward result and never declares profitability', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    for (const card of screen.getAllByTestId('experiment-card'))
      expect(card).toHaveTextContent('el servicio no tiene configurada')
    expect(document.body.textContent).not.toMatch(/B5/)
    expect(document.body.textContent).not.toMatch(/rentable/i)
  })

  it('uses the shared status badges and keeps carry unverified', async () => {
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
  })

  it('keeps retired and turned-off strategies in a collapsed section with reason', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    const section = screen.getByTestId('retired')
    expect(section).not.toHaveAttribute('open')
    expect(screen.getByTestId('stopped-count')).toHaveTextContent('1')
    // Retired ones are not cards of their own.
    expect(
      document.querySelector('[data-testid="experiment-card"][data-id="x5"]'),
    ).toBeNull()
    const retired = within(screen.getByTestId('retired-row'))
    expect(retired.getByText('X5 Cerrada')).toBeInTheDocument()
    expect(retired.getByTestId('operational-badge')).toHaveTextContent(
      'Cerrada',
    )
    expect(screen.getByTestId('retired-row')).toHaveTextContent(
      'Motivo: closed_with_engine_d',
    )
  })

  it('opens the detail of a strategy and offers a new one', async () => {
    const { onOpen, onNew } = renderView()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Detalle de X1 Candidata' }),
    )
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'x1' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Nueva estrategia' }),
    )
    expect(onNew).toHaveBeenCalled()
  })

  it('shows Kronos as verified only with a verified activity read', async () => {
    renderView(vi.fn(), vi.fn(), () =>
      Promise.resolve({
        verified: true as const,
        updated_ms: Date.now() - 10 * 60_000,
        trades: 4,
        decisions: 30,
      }),
    )
    await screen.findAllByTestId('experiment-card')
    const card = document.querySelector('[data-id="x4"]') as HTMLElement
    expect(
      await within(card).findByTestId('kronos-verified'),
    ).toHaveTextContent('Actividad reciente registrada')
    expect(within(card).getByTestId('kronos-activity')).toHaveTextContent(
      new Date(Date.now() - 10 * 60_000)
        .toISOString()
        .slice(0, 13)
        .replace('T', ' '),
    )
    expect(within(card).getByTestId('kronos-activity')).toHaveTextContent(
      'no prueba que el proceso siga corriendo',
    )
    expect(screen.getAllByText('Actividad reciente registrada')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(
      /Actividad verificada|en ejecución|Kronos activo/,
    )
  })

  describe('freshness over time', () => {
    afterEach(() => vi.useRealTimers())
    const T0 = Date.UTC(2026, 9, 14, 12, 0)
    const fresh = (updated: number) => () =>
      Promise.resolve({
        verified: true as const,
        updated_ms: updated,
        trades: 4,
        decisions: 30,
      })

    it('drops to «Estado no verificado» after 90 minutes without a new read', async () => {
      vi.useFakeTimers({
        toFake: ['Date', 'setInterval', 'clearInterval'],
        now: T0,
      })
      const loader = vi
        .fn<() => Promise<KronosActivity>>()
        .mockImplementationOnce(fresh(T0 - 60_000))
        .mockImplementation(() => new Promise(() => {}))
      renderView(vi.fn(), vi.fn(), loader)
      await act(async () => {})
      const card = () => document.querySelector('[data-id="x4"]') as HTMLElement
      expect(within(card()).getByTestId('kronos-verified')).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(100 * 60_000)
      })
      expect(within(card()).queryByTestId('kronos-verified')).toBeNull()
      expect(within(card()).getByTestId('kronos-activity')).toHaveTextContent(
        'Estado no verificado',
      )
    })

    it('does not keep «reciente» when a re-read fails', async () => {
      vi.useFakeTimers({
        toFake: ['Date', 'setInterval', 'clearInterval'],
        now: T0,
      })
      const loader = vi
        .fn<() => Promise<KronosActivity>>()
        .mockImplementationOnce(fresh(T0))
        .mockImplementation(() => Promise.reject(new Error('down')))
      renderView(vi.fn(), vi.fn(), loader)
      await act(async () => {})
      const card = () => document.querySelector('[data-id="x4"]') as HTMLElement
      expect(within(card()).getByTestId('kronos-verified')).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(6 * 60_000)
      })
      expect(loader.mock.calls.length).toBeGreaterThan(1)
      expect(within(card()).queryByTestId('kronos-verified')).toBeNull()
    })
  })

  it('names the Kronos button for what it opens', async () => {
    const onOpen = vi.fn()
    renderView(onOpen)
    await screen.findAllByTestId('experiment-card')
    const card = document.querySelector('[data-id="x4"]') as HTMLElement
    const button = within(card).getByRole('button', {
      name: 'Abrir Kronos en el Laboratorio',
    })
    expect(button).toHaveTextContent('Abrir Kronos en el Laboratorio')
    await userEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'x4' }))
  })

  it('keeps Kronos «Estado no verificado» when the activity is not verified', async () => {
    renderView()
    await screen.findAllByTestId('experiment-card')
    const card = document.querySelector('[data-id="x4"]') as HTMLElement
    expect(within(card).queryByTestId('kronos-verified')).toBeNull()
    expect(within(card).getByTestId('kronos-activity')).toHaveTextContent(
      'Estado no verificado',
    )
    expect(document.body.textContent).not.toMatch(/Actividad reciente/)
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
        onNew={() => {}}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502')
  })
})
