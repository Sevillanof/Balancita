import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import StrategyLab from './StrategyLab.tsx'
import { exampleStrategyApi } from '../infrastructure/example-strategy-api.ts'
import {
  syntheticCandles,
  type LabCandles,
} from '../infrastructure/lab-candles.ts'
import {
  httpStrategyApi,
  type StrategyApi,
} from '../infrastructure/strategy-api.ts'

vi.mock('../../trading-view/presentation/ApprovedTerminalChart.tsx', () => ({
  default: ({ markers }: { markers: unknown[] }) => (
    <div data-testid="lab-chart">{markers.length} marcas</div>
  ),
}))

const market: LabCandles = { source: 'live', candles: syntheticCandles() }
const loadCandles = () => Promise.resolve(market)

async function renderLab(
  api: StrategyApi = exampleStrategyApi(market.candles),
) {
  render(
    <StrategyLab
      loadCandles={loadCandles}
      connect={() => Promise.resolve(api)}
    />,
  )
  await userEvent.click(
    await within(ranking()).findByText('C25 Pullback en tendencia'),
  )
  await screen.findByRole('complementary', {
    name: 'Editar C25 Pullback en tendencia',
  })
  await screen.findByText('Acierto')
  return api
}

function ranking() {
  return screen.getByRole('region', { name: 'Ranking por rentabilidad' })
}

describe('StrategyLab', () => {
  it('ranks C25-C28 and buy and hold with profitability and hit rate', async () => {
    await renderLab()
    const list = within(ranking())
    for (const name of [
      'C25 Pullback en tendencia',
      'C26 Reversion en rango',
      'C27 Ruptura Donchian',
      'C28 Adaptador por regimen',
      'Comprar y mantener',
    ])
      expect(list.getByText(name)).toBeInTheDocument()
    expect(screen.getByText('Rentabilidad')).toBeInTheDocument()
    expect(screen.getAllByText(/de \d+ trades/).length).toBeGreaterThan(0)
    expect(screen.getByTestId('lab-chart')).toBeInTheDocument()
    expect(
      screen.getByText(/El registro de estrategias no respondió/),
    ).toBeInTheDocument()
  })

  it('creates one draft per value of a parameter sweep', async () => {
    const user = userEvent.setup()
    await renderLab()
    await user.click(screen.getByRole('tab', { name: 'Parámetros' }))
    await user.type(screen.getByLabelText('Valores a probar'), '40; 50')
    await user.click(screen.getByRole('button', { name: 'Crear variantes' }))
    expect(
      await within(ranking()).findByText(
        'C25 Pullback en tendencia · rsi_long_min 40',
      ),
    ).toBeInTheDocument()
    expect(
      within(ranking()).getByText(
        'C25 Pullback en tendencia · rsi_long_min 50',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('2 variantes creadas')
  })

  it('saves an edit as a new strategy and keeps the original', async () => {
    const user = userEvent.setup()
    await renderLab()
    await user.click(screen.getByRole('tab', { name: 'Parámetros' }))
    const input = screen.getByLabelText('Parámetro rsi_long_min')
    await user.clear(input)
    await user.type(input, '42')
    await user.tab()
    await user.click(screen.getByRole('button', { name: 'Probar cambios' }))
    expect(
      await within(ranking()).findByText(
        'C25 Pullback en tendencia · cambios sin guardar',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByLabelText('Crear estrategia nueva'))
    const name = screen.getByLabelText('Nombre de la estrategia nueva')
    await user.clear(name)
    await user.type(name, 'Pullback suave')
    await user.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Guardada como C29 · Pullback suave. C25 Pullback en tendencia quedó como estaba.',
    )
    expect(
      await within(ranking()).findByText('C29 · Pullback suave'),
    ).toBeInTheDocument()
    expect(
      within(ranking()).getByText('C25 Pullback en tendencia'),
    ).toBeInTheDocument()
  })

  it('modifies the same strategy into a new version', async () => {
    const user = userEvent.setup()
    await renderLab()
    await user.click(screen.getByRole('tab', { name: 'Riesgo' }))
    const stop = screen.getByLabelText('Stop (× ATR 14)')
    await user.clear(stop)
    await user.type(stop, '2')
    await user.tab()
    await user.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Guardada C25 Pullback en tendencia v2 como borrador.',
    )
    expect(
      await within(ranking()).findByText('C25 Pullback en tendencia v2'),
    ).toBeInTheDocument()
  })

  it('shows the gates a promotion fails', async () => {
    const user = userEvent.setup()
    await renderLab()
    await user.click(screen.getByRole('tab', { name: 'Versiones' }))
    await user.click(screen.getByRole('button', { name: 'Retirar' }))
    await screen.findByText(/pasó a retirada/)
    await user.click(screen.getByLabelText('Crear estrategia nueva'))
    await user.click(screen.getByRole('button', { name: 'Guardar' }))
    await screen.findByText(/Guardada como/)
    await user.click(screen.getByRole('tab', { name: 'Versiones' }))
    await user.click(screen.getByRole('button', { name: 'Pasar a sombra' }))
    await screen.findByText(/pasó a en sombra/)
    await user.click(screen.getByRole('button', { name: 'Activar' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('✗ Sharpe deflactado ≥ 0,95')
  })

  it('rejects an import that is not a strategy', async () => {
    const user = userEvent.setup()
    await renderLab()
    await user.click(screen.getByRole('button', { name: 'Importar' }))
    await user.type(screen.getByLabelText(/Pegá una estrategia/), 'no es json')
    await user.click(
      screen.getByRole('button', { name: 'Importar como borrador' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No es un JSON válido.',
    )
  })

  it('reads the ranking from the registry API when it answers', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
        const body = String(url).includes('/ranking')
          ? {
              product_id: 'PF_XBTUSD',
              days: 30,
              buy_and_hold_pct: 1.5,
              min_trades: 30,
              verdicts_available: true,
              strategies: [
                {
                  id: 'c25-pullback-perp-v1',
                  version: 1,
                  name: 'C25 Pullback en tendencia',
                  description: '',
                  state: 'active',
                  active_version: 1,
                  return_pct: 2.4,
                  pnl_usd: 240,
                  hit_rate: 0.55,
                  trades: 40,
                  wins: 22,
                  few_trades: false,
                  deflated_sharpe_probability: 0.7,
                },
              ],
            }
          : { error: 'verdicts_unavailable', detail: 'sin veredictos' }
        return new Response(JSON.stringify(body), {
          status: String(url).includes('/ranking') ? 200 : 503,
        })
      },
    )
    render(
      <StrategyLab
        loadCandles={loadCandles}
        connect={() =>
          Promise.resolve(httpStrategyApi('/api-strategies', fetcher))
        }
      />,
    )
    expect(await within(ranking()).findByText('55 % · 40')).toBeInTheDocument()
    expect(within(ranking()).getByText('+2,40 %')).toBeInTheDocument()
    expect(calls[0]).toBe(
      'GET /api-strategies/ranking?product=PF_XBTUSD&days=30',
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('sin veredictos')
  })
})
