import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detalleDeOperacion, emparejar } from '../domain/estrategias-velas.ts'
import { firmado } from '../domain/estrategias-format.ts'
import type { Informe, Operacion } from '../infrastructure/estrategias-api.ts'
import {
  INFORME,
  fakeApi,
  velasFalsas,
} from '../testing/estrategias-fixture.ts'
import VelasConOperaciones from './VelasConOperaciones.tsx'

const H = 3_600_000
const HASTA = Date.UTC(2026, 3, 19)
const E0 = Date.UTC(2026, 2, 10, 12)

const op = (
  entradaH: number,
  horas: number,
  lado: 'LONG' | 'SHORT',
  neto: number,
  motivo = 'maestro_vuelta',
  nocional = 300,
): Operacion => ({
  entrada_ms: E0 + entradaH * H,
  salida_ms: E0 + (entradaH + horas) * H,
  lado,
  neto_usd: neto,
  neto_bp: (neto / nocional) * 1e4,
  motivo,
  nocional_usd: nocional,
})

/**
 * Four trades: a LONG both closed at different times, a SHORT the variant cut at its 30 h cap, a LONG both closed in the same
 * instant (their markers coincide), and one only the variant took.
 */
const informe: Informe = {
  ...INFORME,
  oficial: {
    ...INFORME.oficial,
    operaciones: [
      op(0, 20, 'LONG', 30.5, 'maestro_vuelta', 330),
      op(30, 36, 'SHORT', -10, 'tiempo'),
      op(60, 5, 'LONG', 7),
    ],
  },
  variante: {
    ...INFORME.variante,
    operaciones: [
      op(0, 18, 'LONG', 20),
      op(30, 30, 'SHORT', -4.2, 'tiempo'),
      op(60, 5, 'LONG', 7),
      op(80, 5, 'LONG', 3),
    ],
  },
}

async function mostrar(api = fakeApi(), datos = informe) {
  const usuario = userEvent.setup()
  render(<VelasConOperaciones api={api} informe={datos} />)
  await screen.findByTestId('velas')
  return { api, usuario }
}

const titulo = (n: number, de = 4) =>
  screen.getByText(`Operación ${n} de ${de}`)
const salida = (quien: string) => screen.getByTestId(`salida-${quien}`)
const barras = () => screen.queryAllByTestId('barra-operacion')

describe('chart of one trade', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens on «Una operación» of the middle trade, with header, legend and the three exits', async () => {
    const { api } = await mostrar()
    expect(titulo(3)).toBeVisible()
    expect(screen.getByText('▲ LONG')).toBeVisible()
    expect(screen.getByText('13 mar · entra 01:00')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Una operación' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Varias' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    const leyenda = screen.getByLabelText('Leyenda')
    expect(leyenda).toHaveTextContent('OficialVarianteIdeal')
    expect(
      screen.getByRole('img', {
        name: /Velas de ETH alrededor de la operación/,
      }),
    ).toBeVisible()
    for (const quien of ['oficial', 'variante', 'ideal'])
      expect(screen.getByTestId(`pildora-${quien}`)).toBeInTheDocument()
    expect(screen.getByTestId('pildora-entrada')).toHaveTextContent(
      /^entrada [\d.]+,\d\d$/,
    )
    expect(screen.getByTestId('entrada')).toBeInTheDocument()
    expect(screen.getByTestId('banda-abierta')).toBeInTheDocument()
    expect(screen.getByTestId('linea-entrada')).toHaveAttribute(
      'stroke-dasharray',
      '5 4',
    )
    expect(screen.getAllByTestId('salida')).toHaveLength(3)
    // one request, the stretch around the trade, inside the tested window
    expect(api.velas).toHaveBeenCalledTimes(1)
    expect(api.velas).toHaveBeenCalledWith(
      expect.objectContaining({
        producto: 'PF_ETHUSD',
        intervalo: '1h',
        desdeMs: Date.UTC(2026, 1, 3),
        hastaMs: HASTA,
        antesMs: E0 + 120 * H,
      }),
    )
    expect(document.body.textContent).not.toMatch(/tradingview/i)
  })

  it('shows what each exit got, why it closed, and what the official one left against the ideal', async () => {
    const { usuario } = await mostrar()
    await usuario.click(
      screen.getByRole('button', { name: 'Operación anterior' }),
    )
    expect(titulo(2)).toBeVisible()
    expect(screen.getByText('▼ SHORT')).toBeVisible()
    expect(within(salida('oficial')).getByText('−10,0 US$')).toBeVisible()
    expect(salida('oficial')).toHaveTextContent('36,0 h · tope 36 h')
    expect(within(salida('variante')).getByText('−4,2 US$')).toBeVisible()
    expect(salida('variante')).toHaveTextContent('30,0 h · tope 30 h')
    expect(salida('ideal')).toHaveTextContent('mejor precio posible')
    expect(screen.getByTestId('pildora-oficial')).toHaveTextContent(
      'Oficial −10,0',
    )
    expect(screen.getByTestId('pildora-variante')).toHaveTextContent(
      'Variante −4,2',
    )

    const pares = emparejar(informe)
    const velas = velasFalsas({
      producto: 'PF_ETHUSD',
      intervalo: '1h',
      desdeMs: Date.UTC(2026, 1, 3),
      hastaMs: HASTA,
      antesMs: E0 + 120 * H,
      limite: 121,
    }).velas
    const esperado = detalleDeOperacion(pares[1]!, velas, H, {
      topeVarianteH: 30,
    })!
    expect(esperado.faltoUsd).toBeGreaterThan(0)
    expect(esperado.salidas.ideal!.horas).toBeLessThanOrEqual(36)
    const ideal = within(salida('ideal')).getByText(
      `${firmado(esperado.salidas.ideal!.netoUsd, 1)} US$`,
    )
    expect(ideal).toBeVisible()
    const falto = screen.getByText('Le faltó a la oficial').closest('li')!
    expect(falto).toHaveTextContent(`${firmado(esperado.faltoUsd, 1)} US$`)
    expect(falto).toHaveTextContent('contra la ideal')
  })

  it('goes through the trades with ‹ › and stops at both ends', async () => {
    const { usuario } = await mostrar()
    const anterior = screen.getByRole('button', { name: 'Operación anterior' })
    const siguiente = screen.getByRole('button', {
      name: 'Operación siguiente',
    })
    await usuario.click(siguiente)
    expect(titulo(4)).toBeVisible()
    expect(siguiente).toBeDisabled()
    await usuario.click(anterior)
    await usuario.click(anterior)
    await usuario.click(anterior)
    expect(titulo(1)).toBeVisible()
    expect(anterior).toBeDisabled()
    expect(screen.getByText('▲ LONG')).toBeVisible()
    expect(within(salida('oficial')).getByText('+30,5 US$')).toBeVisible()
    expect(salida('oficial')).toHaveTextContent('20,0 h · regla de salida')
    expect(salida('variante')).toHaveTextContent('18,0 h · regla de salida')
  })

  it('says «igual que la oficial» when the variant closed it at the same moment', async () => {
    await mostrar()
    expect(salida('variante')).toHaveTextContent('5,0 h · igual que la oficial')
  })

  it('keeps the pills of the exits apart even when the markers coincide', async () => {
    await mostrar()
    // the third trade: official and variant closed at the same time with the same net
    const cajas = ['oficial', 'variante', 'ideal', 'entrada'].map((q) => {
      const rect = screen.getByTestId(`pildora-${q}`).querySelector('rect')!
      const dato = (nombre: string) => Number(rect.getAttribute(nombre))
      return { x: dato('x'), y: dato('y'), w: dato('width'), h: dato('height') }
    })
    for (let a = 0; a < cajas.length; a++)
      for (let b = a + 1; b < cajas.length; b++) {
        const p = cajas[a]!
        const q = cajas[b]!
        const seTocan =
          p.x < q.x + q.w &&
          q.x < p.x + p.w &&
          p.y < q.y + q.h &&
          q.y < p.y + p.h
        expect(seTocan).toBe(false)
      }
  })

  it('does not cover the markers of the exits with a pill', async () => {
    const { usuario } = await mostrar()
    const siguiente = screen.getByRole('button', { name: 'Operación anterior' })
    for (let vez = 0; vez < 3; vez++) {
      const pildoras = ['oficial', 'variante', 'ideal'].flatMap((quien) => {
        const rect = screen
          .queryByTestId(`pildora-${quien}`)
          ?.querySelector('rect')
        return rect
          ? [
              {
                x: Number(rect.getAttribute('x')),
                y: Number(rect.getAttribute('y')),
                w: Number(rect.getAttribute('width')),
                h: Number(rect.getAttribute('height')),
              },
            ]
          : []
      })
      const marcas = screen.getAllByTestId('salida').map((salida) => {
        const circulo = salida.querySelector('circle')
        if (circulo)
          return {
            x: Number(circulo.getAttribute('cx')),
            y: Number(circulo.getAttribute('cy')),
          }
        const [, x, y] = /translate\(([\d.-]+) ([\d.-]+)\)/.exec(
          salida.querySelector('path')!.getAttribute('transform')!,
        )!
        return { x: Number(x), y: Number(y) }
      })
      for (const pildora of pildoras)
        for (const marca of marcas) {
          const tapa =
            marca.x + 6 > pildora.x &&
            marca.x - 6 < pildora.x + pildora.w &&
            marca.y + 6 > pildora.y &&
            marca.y - 6 < pildora.y + pildora.h
          expect(tapa).toBe(false)
        }
      await usuario.click(siguiente)
    }
  })

  it('leaves a missing exit as «—» and «no operó» when only the variant took the trade', async () => {
    const { usuario } = await mostrar()
    await usuario.click(
      screen.getByRole('button', { name: 'Operación siguiente' }),
    )
    expect(titulo(4)).toBeVisible()
    expect(within(salida('oficial')).getByText('—')).toBeVisible()
    expect(salida('oficial')).toHaveTextContent('no operó')
    expect(within(salida('variante')).getByText('+3,0 US$')).toBeVisible()
    expect(screen.queryByTestId('pildora-oficial')).toBeNull()
    expect(screen.getByTestId('pildora-variante')).toBeInTheDocument()
    expect(screen.getByTestId('pildora-ideal')).toBeInTheDocument()
    expect(
      screen.getByText('Le faltó a la oficial').closest('li'),
    ).toHaveTextContent('—')
  })

  it('cannot price the ideal when the server does not send the size, and says «—»', async () => {
    const sinTamano: Informe = {
      ...informe,
      oficial: {
        ...informe.oficial,
        operaciones: informe.oficial.operaciones.map((o) => ({
          ...o,
          nocional_usd: undefined,
        })),
      },
      variante: {
        ...informe.variante,
        operaciones: informe.variante.operaciones.map((o) => ({
          ...o,
          nocional_usd: undefined,
        })),
      },
    }
    await mostrar(fakeApi(), sinTamano)
    expect(within(salida('ideal')).getByText('—')).toBeVisible()
    expect(
      screen.getByText('Le faltó a la oficial').closest('li'),
    ).toHaveTextContent('—')
    expect(within(salida('oficial')).getByText('+7,0 US$')).toBeVisible()
  })

  it('asks for the chosen timeframe, shows it pressed and keeps the trade', async () => {
    const { api, usuario } = await mostrar()
    await usuario.click(screen.getByRole('button', { name: '4h' }))
    await waitFor(() =>
      expect(api.velas).toHaveBeenLastCalledWith(
        expect.objectContaining({ intervalo: '4h', antesMs: E0 + 140 * H }),
      ),
    )
    expect(screen.getByRole('button', { name: '4h' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    for (const id of ['15m', '1d'])
      expect(screen.getByRole('button', { name: id })).toBeVisible()
    await screen.findByTestId('velas')
    expect(titulo(3)).toBeVisible()
  })

  it('never asks past the end of the tested window nor draws a candle outside it', async () => {
    const alFinal: Informe = {
      ...informe,
      oficial: {
        ...informe.oficial,
        operaciones: [
          {
            ...op(0, 5, 'LONG', 3),
            entrada_ms: HASTA - 10 * H,
            salida_ms: HASTA - 5 * H,
          },
        ],
      },
      variante: { ...informe.variante, operaciones: [] },
    }
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(async (consulta) => {
          const real = velasFalsas(consulta)
          const sobra = real.velas.at(-1)!
          return {
            ...real,
            velas: [
              ...real.velas,
              { ...sobra, t: HASTA },
              { ...sobra, t: HASTA + H },
            ],
          }
        }),
      },
    )
    await mostrar(api, alFinal)
    for (const [consulta] of api.velas.mock.calls)
      expect(consulta.antesMs).toBeLessThanOrEqual(HASTA)
    const velas = screen.getByTestId('velas')
    expect(velas.querySelectorAll('rect').length).toBeGreaterThan(0)
    expect(velas.querySelectorAll('rect').length).toBeLessThanOrEqual(61)
  })
})

describe('chart of several trades', () => {
  beforeEach(() => vi.clearAllMocks())

  async function enVarias() {
    const base = await mostrar()
    await base.usuario.click(screen.getByRole('button', { name: 'Varias' }))
    return base
  }

  it('switches the toggle, keeps the trade and shows candles with one bar per trade of the five days', async () => {
    const { api } = await enVarias()
    expect(screen.getByRole('button', { name: 'Varias' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(
      screen.getByRole('group', { name: /Velas de ETH de unos cinco días/ }),
    ).toBeVisible()
    expect(titulo(3)).toBeVisible()
    expect(barras()).toHaveLength(4)
    expect(screen.getByTestId('velas')).toBeInTheDocument()
    // the toggle does not ask again: the same candles serve both modes
    expect(api.velas).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText(/Varias operaciones: cada barra es una operación/),
    ).toBeVisible()
  })

  it('labels each bar «▲/▼ net», outlines the chosen one and marks where the variant left at another moment', async () => {
    await enVarias()
    const textos = barras().map((b) => b.querySelector('text')!.textContent)
    expect(textos).toEqual(['▲ +30,5', '▼ −10,0', '▲ +7,0', '▲ +3,0'])
    const [a, b, c, d] = barras()
    expect(c).toHaveAttribute('data-elegida', 'true')
    expect(a).toHaveAttribute('data-elegida', 'false')
    expect(c!.querySelector('rect')).toHaveAttribute('stroke-width', '2')
    expect(a!.querySelector('rect')).toHaveAttribute('stroke-width', '1')
    // green when the official won, red when it lost
    expect(a!.querySelector('rect')).toHaveAttribute(
      'stroke',
      'var(--color-long)',
    )
    expect(b!.querySelector('rect')).toHaveAttribute(
      'stroke',
      'var(--color-short)',
    )
    // amber tick only where the variant exit differs from the official one
    expect(within(a!).getAllByTestId('corte-variante')).toHaveLength(1)
    expect(within(b!).getAllByTestId('corte-variante')).toHaveLength(1)
    expect(within(c!).queryAllByTestId('corte-variante')).toHaveLength(0)
    expect(within(d!).queryAllByTestId('corte-variante')).toHaveLength(0)
    expect(within(b!).getByTestId('corte-variante')).toHaveAttribute(
      'stroke',
      'var(--color-warn)',
    )
    // dotted connector to the entry price on the candles
    expect(a!.querySelector('line[stroke-dasharray="2 3"]')).not.toBeNull()
  })

  it('lays the bars in rows without overlapping, labels included', async () => {
    await enVarias()
    const cajas = barras().map((barra) => {
      const rect = barra.querySelector('rect')!
      const texto = barra.querySelector('text')!
      const x = Number(rect.getAttribute('x'))
      const w = Number(rect.getAttribute('width'))
      const largo = (texto.textContent ?? '').length * 7 + 16
      const dentro = Number(texto.getAttribute('x')) < x + w
      return {
        y: Number(rect.getAttribute('y')),
        h: Number(rect.getAttribute('height')),
        x0: x,
        x1: dentro ? x + w : x + w + largo,
      }
    })
    for (let a = 0; a < cajas.length; a++)
      for (let b = a + 1; b < cajas.length; b++) {
        const p = cajas[a]!
        const q = cajas[b]!
        const mismaFila = p.y < q.y + q.h && q.y < p.y + p.h
        if (mismaFila) expect(p.x1 <= q.x0 || q.x1 <= p.x0).toBe(true)
      }
    expect(new Set(cajas.map((c) => c.y)).size).toBeGreaterThan(1)
  })

  it('clicking a bar chooses that trade and goes back to «Una operación»', async () => {
    const { usuario } = await enVarias()
    await usuario.click(barras()[1]!)
    expect(titulo(2)).toBeVisible()
    expect(screen.getByText('▼ SHORT')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Una operación' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('img', {
        name: /Velas de ETH alrededor de la operación/,
      }),
    ).toBeVisible()
    expect(within(salida('oficial')).getByText('−10,0 US$')).toBeVisible()
  })

  it('a bar can be chosen with the keyboard', async () => {
    const { usuario } = await enVarias()
    barras()[0]!.focus()
    await usuario.keyboard('{Enter}')
    expect(titulo(1)).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Una operación' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('lists the bars with their name for assistive technology', async () => {
    await enVarias()
    expect(
      screen.getByRole('button', {
        name: 'Operación 2 de 4: SHORT, −10,0 US$',
      }),
    ).toBeInTheDocument()
  })
})

describe('without data', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says why there are no candles instead of an empty chart', async () => {
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(async () => {
          throw new Error('No hay velas guardadas de PF_ETHUSD.')
        }),
      },
    )
    render(<VelasConOperaciones api={api} informe={informe} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No hay velas guardadas de PF_ETHUSD.',
    )
    expect(screen.queryByTestId('velas')).toBeNull()
  })

  it('says «Sin velas en la ventana probada» when the window has none around the trade', async () => {
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(async (consulta) => ({
          ...velasFalsas(consulta),
          velas: [],
          hay_mas: false,
        })),
      },
    )
    render(<VelasConOperaciones api={api} informe={informe} />)
    expect(
      await screen.findByText('Sin velas en la ventana probada'),
    ).toBeVisible()
  })

  it('says there are no trades and asks for no candles', async () => {
    const api = fakeApi()
    render(
      <VelasConOperaciones
        api={api}
        informe={{
          ...informe,
          oficial: { ...informe.oficial, operaciones: [] },
          variante: { ...informe.variante, operaciones: [] },
        }}
      />,
    )
    expect(
      await screen.findByText('Sin operaciones en la ventana probada'),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Operación anterior' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Operación siguiente' }),
    ).toBeDisabled()
    expect(api.velas).not.toHaveBeenCalled()
  })
})
