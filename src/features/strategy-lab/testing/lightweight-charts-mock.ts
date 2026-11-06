import { vi } from 'vitest'

/**
 * A stand-in for `lightweight-charts` in jsdom (no canvas): `vi.mock('lightweight-charts', async () =>
 * (await import('../testing/lightweight-charts-mock.ts')).modulo)`. It lays candle `i` at x = 10 · i, price `p` at y = 3000 − p,
 * and calls the attached primitive like the real chart does, so the trade overlay is computed for real.
 */
type Primitiva = {
  attached: (p: unknown) => void
  updateAllViews: () => void
}

let primitiva: Primitiva | null = null

const serie = {
  setData: vi.fn(),
  priceToCoordinate: vi.fn((precio: number) => 3000 - precio),
  attachPrimitive: vi.fn((p: Primitiva) => {
    primitiva = p
    p.attached({
      chart: grafico,
      series: serie,
      requestUpdate: () => p.updateAllViews(),
    })
  }),
}

const escala = {
  fitContent: vi.fn(),
  getVisibleLogicalRange: vi.fn(() => ({ from: 40, to: 240 })),
  setVisibleLogicalRange: vi.fn(),
  logicalToCoordinate: vi.fn((logico: number) => logico * 10),
  subscribeVisibleLogicalRangeChange: vi.fn(),
  unsubscribeVisibleLogicalRangeChange: vi.fn(),
}

const grafico = {
  addSeries: vi.fn(() => serie),
  timeScale: vi.fn(() => escala),
  paneSize: vi.fn(() => ({ width: 6000, height: 400 })),
  subscribeCrosshairMove: vi.fn(),
  unsubscribeCrosshairMove: vi.fn(),
  remove: vi.fn(),
}

const crear = vi.fn(() => grafico)

export const modulo = {
  ColorType: { Solid: 'solid' },
  CandlestickSeries: 'candles',
  createChart: crear,
}

export const mockGrafico = {
  crear,
  grafico,
  serie,
  escala,
  /** The last candle list handed to the series, as the chart got it. */
  velasPuestas: () =>
    (serie.setData.mock.calls.at(-1)?.[0] ?? []) as Array<{
      time: number
      open: number
      close: number
    }>,
  /** The pointer moves over the chart (`null` = leaves it). */
  moverPuntero: (punto: { x: number; y: number } | null) => {
    const manejador = grafico.subscribeCrosshairMove.mock.calls.at(-1)?.[0] as
      ((param: { point?: { x: number; y: number } }) => void) | undefined
    manejador?.({ point: punto ?? undefined })
  },
  /** The visible range changes (`from` is the logical index of the left edge). */
  moverRango: (from: number) => {
    const manejador = escala.subscribeVisibleLogicalRangeChange.mock.calls.at(
      -1,
    )?.[0] as ((rango: { from: number; to: number }) => void) | undefined
    manejador?.({ from, to: from + 200 })
  },
  primitiva: () => primitiva,
}
