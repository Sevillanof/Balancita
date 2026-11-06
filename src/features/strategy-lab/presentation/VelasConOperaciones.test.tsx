import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Informe, Operacion } from '../infrastructure/estrategias-api.ts'
import {
  INFORME,
  fakeApi,
  velasFalsas,
} from '../testing/estrategias-fixture.ts'
import { mockGrafico } from '../testing/lightweight-charts-mock.ts'
import VelasConOperaciones from './VelasConOperaciones.tsx'

vi.mock(
  'lightweight-charts',
  async () => (await import('../testing/lightweight-charts-mock.ts')).modulo,
)

const H = 3_600_000
const HASTA = Date.UTC(2026, 3, 19)
const DESDE = Date.UTC(2026, 1, 3)

const op = (
  horasAntes: number,
  horas: number,
  lado: 'LONG' | 'SHORT',
  neto: number,
  motivo = 'maestro_vuelta',
): Operacion => ({
  entrada_ms: HASTA - horasAntes * H,
  salida_ms: HASTA - (horasAntes - horas) * H,
  lado,
  neto_usd: neto,
  neto_bp: neto * 10,
  motivo,
})

/** Two trades inside the first ten days shown: the second one the variant cut at the time cap. */
const informe: Informe = {
  ...INFORME,
  oficial: {
    ...INFORME.oficial,
    operaciones: [
      op(100, 20, 'LONG', 30.5),
      op(60, 36, 'SHORT', -10, 'tiempo'),
      op(1000, 5, 'LONG', 7),
    ],
  },
  variante: {
    ...INFORME.variante,
    operaciones: [
      op(100, 18, 'LONG', 20),
      op(60, 30, 'SHORT', -4.25, 'tiempo'),
      op(1000, 5, 'LONG', 7),
    ],
  },
}

async function mostrar(api = fakeApi()) {
  const usuario = userEvent.setup()
  render(<VelasConOperaciones api={api} informe={informe} />)
  await waitFor(() => expect(mockGrafico.velasPuestas()).toHaveLength(240))
  return { api, usuario }
}

const operaciones = () => screen.queryAllByTestId('operacion-en-velas')

describe('candles with the trades', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a chart region with ETH candles of the tested window, 1 h by default and the last ten days', async () => {
    const { api } = await mostrar()
    expect(
      screen.getByRole('img', { name: /Velas de ETH con las operaciones/ }),
    ).toBeVisible()
    expect(screen.getByText('ETH / USD')).toBeVisible()
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(api.velas).toHaveBeenCalledWith(
      expect.objectContaining({
        producto: 'PF_ETHUSD',
        intervalo: '1h',
        desdeMs: DESDE,
        hastaMs: HASTA,
        antesMs: HASTA,
        limite: 240,
      }),
    )
    const velas = mockGrafico.velasPuestas()
    expect(velas[0]!.time).toBe((HASTA - 240 * H) / 1000)
    expect(velas.at(-1)!.time).toBe((HASTA - H) / 1000)
    expect(mockGrafico.escala.fitContent).toHaveBeenCalled()
  })

  it('draws entry ▲/▼, a line and a closing mark per configuration for the trades whose candle is loaded', async () => {
    await mostrar()
    await waitFor(() => expect(operaciones()).toHaveLength(2))
    const [larga, corta] = operaciones()
    expect(larga).toHaveAttribute('data-lado', 'LONG')
    expect(corta).toHaveAttribute('data-lado', 'SHORT')
    expect(within(larga!).getAllByTestId('cierre')).toHaveLength(2)
    expect(within(larga!).getByTestId('entrada')).toBeInTheDocument()
    expect(larga!.querySelectorAll('line')).toHaveLength(2)
    // ✕ instead of ● for the variant that the time cap cut
    expect(within(corta!).getAllByTestId('cierre')).toHaveLength(1)
    expect(within(corta!).getAllByTestId('corte-variante')).toHaveLength(1)
    const lineas = corta!.querySelectorAll('line')
    expect(Number(lineas[1]!.getAttribute('y1'))).toBe(
      Number(lineas[0]!.getAttribute('y1')) + 4,
    )
    expect(
      corta!.querySelector(
        '[data-quien="variante"] [data-testid="corte-variante"]',
      ),
    ).not.toBeNull()
  })

  it('hides a configuration with its checkbox, the entry marks stay while one is visible', async () => {
    const { usuario } = await mostrar()
    await waitFor(() => expect(operaciones()).toHaveLength(2))
    await usuario.click(screen.getByRole('checkbox', { name: 'Variante' }))
    await waitFor(() =>
      expect(
        operaciones()[0]!.querySelectorAll('[data-quien="variante"]'),
      ).toHaveLength(0),
    )
    expect(operaciones()).toHaveLength(2)
    expect(screen.queryAllByTestId('corte-variante')).toHaveLength(0)
    await usuario.click(screen.getByRole('checkbox', { name: 'Oficial' }))
    await waitFor(() => expect(operaciones()).toHaveLength(0))
    await usuario.click(screen.getByRole('checkbox', { name: 'Variante' }))
    await waitFor(() => expect(operaciones()).toHaveLength(2))
    expect(
      operaciones()[0]!.querySelectorAll('[data-quien="oficial"]'),
    ).toHaveLength(0)
  })

  it('asks the server for the chosen timeframe and shows it pressed', async () => {
    const { api, usuario } = await mostrar()
    await usuario.click(screen.getByRole('button', { name: '4h' }))
    await waitFor(() => expect(mockGrafico.velasPuestas()).toHaveLength(60))
    expect(api.velas).toHaveBeenLastCalledWith(
      expect.objectContaining({ intervalo: '4h', limite: 60, antesMs: HASTA }),
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
  })

  it('shows side, date, hours and net of both configurations under the pointer, and the cut', async () => {
    await mostrar()
    await waitFor(() => expect(operaciones()).toHaveLength(2))
    const linea = operaciones()[1]!.querySelector('line')!
    const x =
      (Number(linea.getAttribute('x1')) + Number(linea.getAttribute('x2'))) / 2
    const y = Number(linea.getAttribute('y1'))
    act(() => mockGrafico.moverPuntero({ x, y }))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('▼ SHORT · 16 abr 12:00')
    expect(tooltip).toHaveTextContent('Oficial · 36,0 h')
    expect(tooltip).toHaveTextContent('−10,00 US$')
    expect(tooltip).toHaveTextContent('Variante · 30,0 h')
    expect(tooltip).toHaveTextContent('−4,25 US$')
    expect(tooltip).toHaveTextContent(
      'La variante la cortó por el tope de horas',
    )
    act(() => mockGrafico.moverPuntero({ x: x, y: y + 80 }))
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => mockGrafico.moverPuntero(null))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('only lists the visible configuration in the tooltip', async () => {
    const { usuario } = await mostrar()
    await waitFor(() => expect(operaciones()).toHaveLength(2))
    await usuario.click(screen.getByRole('checkbox', { name: 'Variante' }))
    await waitFor(() =>
      expect(
        operaciones()[0]!.querySelectorAll('[data-quien="variante"]'),
      ).toHaveLength(0),
    )
    const linea = operaciones()[0]!.querySelector('line')!
    act(() =>
      mockGrafico.moverPuntero({
        x: Number(linea.getAttribute('x1')) + 5,
        y: Number(linea.getAttribute('y1')),
      }),
    )
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('▲ LONG')
    expect(tooltip).toHaveTextContent('Oficial · 20,0 h')
    expect(tooltip).not.toHaveTextContent('Variante')
  })

  it('scrolling to the oldest candle loads the page before it, keeps the view and stops at the window start', async () => {
    const { api } = await mostrar()
    const primera = (HASTA - 240 * H) / 1000
    act(() => mockGrafico.moverRango(100))
    expect(api.velas).toHaveBeenCalledTimes(1)
    act(() => mockGrafico.moverRango(3))
    await waitFor(() => expect(mockGrafico.velasPuestas()).toHaveLength(740))
    expect(api.velas).toHaveBeenLastCalledWith(
      expect.objectContaining({ antesMs: primera * 1000, limite: 500 }),
    )
    expect(mockGrafico.escala.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: 540,
      to: 740,
    })
    // 75 days of the window are 1800 candles: two more pages reach its start and nothing is asked after it
    for (const total of [1240, 1740, 1800]) {
      act(() => mockGrafico.moverRango(3))
      await waitFor(() =>
        expect(mockGrafico.velasPuestas()).toHaveLength(total),
      )
    }
    const llamadas = api.velas.mock.calls.length
    act(() => mockGrafico.moverRango(0))
    expect(api.velas.mock.calls.length).toBe(llamadas)
    expect(mockGrafico.velasPuestas()[0]!.time).toBe(DESDE / 1000)
  })

  it('never reaches past the end of the window nor before its start, whatever the server answers', async () => {
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(async (consulta) => {
          const real = velasFalsas(consulta)
          const sobra = real.velas[0]!
          return {
            ...real,
            velas: [
              { ...sobra, t: DESDE - 5 * H },
              ...real.velas,
              { ...sobra, t: HASTA },
              { ...sobra, t: HASTA + H },
            ],
          }
        }),
      },
    )
    await mostrar(api)
    const tiempos = mockGrafico.velasPuestas().map((v) => v.time * 1000)
    expect(Math.min(...tiempos)).toBeGreaterThanOrEqual(DESDE)
    expect(Math.max(...tiempos)).toBeLessThan(HASTA)
  })

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
  })
})
