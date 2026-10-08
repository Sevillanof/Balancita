import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import StrategyLab from './StrategyLab.tsx'
import { exampleStrategyApi } from '../testing/example-strategy-api.ts'
import {
  syntheticCandles,
  type LabCandles,
} from '../infrastructure/lab-candles.ts'
import type { QwenScores } from '../infrastructure/qwen-scores.ts'
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

const qwenOff: QwenScores = {
  status: 'off',
  reason: 'decisions_or_verdicts_db_missing',
  products: [],
}

const stats = (hits: number, misses: number) => ({
  decisions: hits + misses,
  scored: hits + misses,
  pending: 0,
  hits,
  misses,
  points: hits - misses,
  hit_rate: hits + misses === 0 ? null : hits / (hits + misses),
  mean_net_bp: 1,
  total_net_bp: 10,
})

const qwenOn: QwenScores = {
  status: 'ok',
  products: [
    {
      product_id: 'PF_XBTUSD',
      horizon_min: 30,
      decisions: { ...stats(41, 54), decisions: 120, pending: 25 },
      by_option: {
        buy: stats(20, 30),
        hold: stats(15, 10),
        sell: stats(6, 14),
      },
      trading: {
        trades: 12,
        wins: 5,
        hit_rate: 5 / 12,
        pnl_usd: 123.4,
        return_pct: 1.234,
        max_drawdown: { pct: -0.5, at_ms: null },
      },
      rows: [
        {
          bucket_start: market.candles.at(-1)!.time * 1000,
          chosen: 'buy',
          confidence: 0.4,
          status: 'scored',
          point: 1,
          net_bp: 8,
        },
      ],
      trades: [
        {
          side: 'SHORT',
          entry_time_ms: 1_700_000_000_000,
          entry_price: '60000',
          exit_time_ms: 1_700_001_800_000,
          exit_price: '59900',
          exit_reason: 'time_stop',
          net_bp: 12.5,
          pnl_usd: 0.125,
        },
      ],
      open_position: {
        side: 'LONG',
        entry_time_ms: 1_700_003_000_000,
        entry_price: '60100',
        mark_price: '60200',
        net_bp: -3,
        pnl_usd: -0.03,
      },
    },
  ],
}

const kronosProduct = qwenOn.products[0]!
const kronosOn: QwenScores = {
  status: 'ok',
  products: [
    {
      ...kronosProduct,
      horizon_min: 240,
      decisions: { ...stats(1, 0), decisions: 3, pending: 1 },
      by_option: { buy: stats(1, 0), hold: stats(0, 0), sell: stats(0, 0) },
      baseline: undefined,
      trading: {
        trades: 1,
        wins: 1,
        hit_rate: 1,
        pnl_usd: 0.4261,
        return_pct: 0.4261,
        max_drawdown: { pct: 0, at_ms: null },
      },
      rows: [],
      trades: [
        {
          side: 'LONG',
          entry_time_ms: market.candles.at(-5)!.time * 1000,
          entry_price: '108.51',
          exit_time_ms: market.candles.at(-1)!.time * 1000,
          exit_price: '109.08',
          exit_reason: 'time_stop',
          net_bp: 42.6,
          pnl_usd: 0.4261,
        },
      ],
      open_position: {
        side: 'SHORT',
        entry_time_ms: 1_700_020_000_000,
        entry_price: null,
        mark_price: null,
        net_bp: null,
        pnl_usd: null,
      },
    },
  ],
}

async function renderLab(
  api: StrategyApi = exampleStrategyApi(market.candles),
  qwen: QwenScores = qwenOff,
  kronos: QwenScores = kronosOn,
) {
  render(
    <StrategyLab
      loadCandles={loadCandles}
      connect={() => Promise.resolve(api)}
      loadQwen={() => Promise.resolve(qwen)}
      loadKronos={() => Promise.resolve(kronos)}
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
    // Qwen and Kronos rank in their own group, after the strategies.
    const models = list.getByRole('heading', { name: 'Modelos' })
    expect(
      within(models.parentElement!).getByRole('button', { name: /^Qwen/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('Rentabilidad')).toBeInTheDocument()
    expect(screen.getAllByText(/de \d+ trades/).length).toBeGreaterThan(0)
    expect(screen.getByTestId('lab-chart')).toBeInTheDocument()
    expect(
      screen.getByText(/El registro de estrategias no respondió/),
    ).toBeInTheDocument()
  })

  it('reads rules as sentences and edits them on demand', async () => {
    await renderLab()
    expect(screen.queryByLabelText(/Condición \d+: comparador/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Editar reglas' }))
    const before = screen.getAllByLabelText(/Condición \d+: comparador/).length
    await userEvent.click(screen.getByRole('button', { name: '+ condición' }))
    expect(screen.getAllByLabelText(/Condición \d+: comparador/)).toHaveLength(
      before + 1,
    )
    await userEvent.click(
      screen.getByRole('button', { name: `Quitar condición ${before + 1}` }),
    )
    expect(screen.getAllByLabelText(/Condición \d+: comparador/)).toHaveLength(
      before,
    )
  })

  it('asks Qwen scores for the selected product', async () => {
    const loadQwen = vi.fn(() => Promise.resolve(qwenOff))
    render(
      <StrategyLab
        loadCandles={loadCandles}
        connect={() => Promise.resolve(exampleStrategyApi(market.candles))}
        loadQwen={loadQwen}
      />,
    )
    await userEvent.selectOptions(
      await screen.findByLabelText('Producto'),
      'PF_ETHUSD',
    )
    expect(loadQwen).toHaveBeenLastCalledWith('PF_ETHUSD')
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

  it('ranks Qwen with its paper return and shows its +1/-1 score', async () => {
    const user = userEvent.setup()
    await renderLab(undefined, qwenOn)
    expect(within(ranking()).getByText('+1,23 %')).toBeInTheDocument()
    await user.click(within(ranking()).getByRole('button', { name: /^Qwen/ }))
    expect(screen.getByText('41 de 95 decisiones')).toBeInTheDocument()
    expect(screen.getByText('−13')).toBeInTheDocument()
    expect(screen.getByText('40 % · 60 % · 30 %')).toBeInTheDocument()
    const side = screen.getByRole('complementary', {
      name: 'Decisiones de Qwen',
    })
    expect(within(side).getByText('Mantener')).toBeInTheDocument()
    expect(within(side).getByText('+5')).toBeInTheDocument()
    const open = within(side).getByText('Abierta').closest('li')!
    expect(open).toHaveTextContent('entrada 60.100,00')
    expect(open).toHaveTextContent('−0,03 %')
    const closed = within(side)
      .getByText(/cierre 59\.900,00/)
      .closest('li')!
    expect(closed).toHaveTextContent('Venta')
    expect(closed).toHaveTextContent('+0,13 %')
    expect(within(side).queryByText('pendiente')).not.toBeInTheDocument()
  })

  it('explains that Qwen has no decisions yet', async () => {
    const user = userEvent.setup()
    await renderLab()
    expect(within(ranking()).getByText('sin decisiones')).toBeInTheDocument()
    await user.click(within(ranking()).getByRole('button', { name: /^Qwen/ }))
    expect(
      screen.getByText(/Qwen todavía no guardó decisiones/),
    ).toBeInTheDocument()
  })

  it('asks Kronos scores for the selected product', async () => {
    const loadKronos = vi.fn(() => Promise.resolve(kronosOn))
    render(
      <StrategyLab
        loadCandles={loadCandles}
        connect={() => Promise.resolve(exampleStrategyApi(market.candles))}
        loadQwen={() => Promise.resolve(qwenOff)}
        loadKronos={loadKronos}
      />,
    )
    await userEvent.selectOptions(
      await screen.findByLabelText('Producto'),
      'PF_ETHUSD',
    )
    expect(loadKronos).toHaveBeenLastCalledWith('PF_ETHUSD')
  })

  it('ranks Kronos with its paper return and shows its latest trades', async () => {
    const user = userEvent.setup()
    await renderLab()
    expect(within(ranking()).getByText('+0,43 %')).toBeInTheDocument()
    await user.click(within(ranking()).getByRole('button', { name: /^Kronos/ }))
    expect(screen.getByRole('heading', { name: 'Kronos' })).toBeInTheDocument()
    expect(screen.getByText('Predice con velas de 1 h')).toBeInTheDocument()
    expect(
      screen.getByText('Se mide hacia delante · 4 h por operación'),
    ).toBeInTheDocument()
    expect(screen.getByText('1 de 1 decisiones')).toBeInTheDocument()
    expect(screen.queryByText(/Siempre «mantener»/)).not.toBeInTheDocument()
    const side = screen.getByRole('complementary', {
      name: 'Decisiones de Kronos',
    })
    const open = within(side).getByText('Abierta').closest('li')!
    expect(open).toHaveTextContent('Venta')
    expect(open).toHaveTextContent('entrada —')
    const closed = within(side)
      .getByText(/cierre 109,08/)
      .closest('li')!
    expect(closed).toHaveTextContent('entrada 108,51')
    expect(closed).toHaveTextContent('+0,43 %')
    expect(screen.getByTestId('lab-chart')).toHaveTextContent('2 marcas')
  })

  it('says Kronos has not closed any trade yet', async () => {
    const user = userEvent.setup()
    const product = kronosOn.products[0]!
    await renderLab(undefined, qwenOff, {
      ...kronosOn,
      products: [{ ...product, trades: [], open_position: null }],
    })
    await user.click(within(ranking()).getByRole('button', { name: /^Kronos/ }))
    expect(
      screen.getByText('Kronos todavía no cerró ninguna operación.'),
    ).toBeInTheDocument()
  })

  it('opens a modal from Nueva estrategia and rejects bad JSON', async () => {
    const user = userEvent.setup()
    await renderLab()
    await user.click(screen.getByRole('button', { name: 'Nueva estrategia' }))
    const dialog = screen.getByRole('dialog', { name: 'Nueva estrategia' })
    await user.type(within(dialog).getByLabelText(/Pegá el JSON/), 'no es json')
    await user.click(
      within(dialog).getByRole('button', { name: 'Agregar estrategia' }),
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No es un JSON válido.',
    )
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
        loadQwen={() => Promise.resolve(qwenOff)}
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

describe('StrategyLab without the registry', () => {
  it('shows the error and no made-up strategies', async () => {
    render(
      <StrategyLab
        loadCandles={() => Promise.resolve(market)}
        connect={() => Promise.reject(new Error('El registro no respondió.'))}
        loadQwen={() => Promise.resolve(null as never)}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /El registro no respondió\. No se muestran datos de ejemplo/,
    )
  })
})
