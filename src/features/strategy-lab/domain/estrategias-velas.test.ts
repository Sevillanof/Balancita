import { describe, expect, it } from 'vitest'
import {
  contenidoTooltip,
  emparejar,
  marcas,
  proyectar,
  buscarOperacion,
  precioEnVela,
  velasIniciales,
  velasPorPagina,
  ventanaDeInforme,
  type MapaProyeccion,
  type Vela,
} from './estrategias-velas.ts'
import { INFORME } from '../testing/estrategias-fixture.ts'
import type { Informe, Operacion } from '../infrastructure/estrategias-api.ts'

const H = 3_600_000
const T0 = Date.UTC(2026, 1, 10, 12)

const op = (
  entradaH: number,
  horas: number,
  lado: 'LONG' | 'SHORT',
  neto: number,
  motivo = 'maestro_vuelta',
): Operacion => ({
  entrada_ms: T0 + entradaH * H,
  salida_ms: T0 + (entradaH + horas) * H,
  lado,
  neto_usd: neto,
  neto_bp: neto * 10,
  motivo,
})

const informe = (oficial: Operacion[], variante: Operacion[]): Informe => ({
  ...INFORME,
  oficial: { ...INFORME.oficial, operaciones: oficial },
  variante: { ...INFORME.variante, operaciones: variante },
})

const VISIBLES = { oficial: true, variante: true }

describe('window of the chart', () => {
  it('is the tested window of the informe: effective start to the end the server measured', () => {
    expect(ventanaDeInforme(INFORME)).toEqual({
      desdeMs: Date.UTC(2026, 1, 3),
      hastaMs: Date.UTC(2026, 3, 19),
    })
  })

  it('falls back to the dates of the window when an old informe has no milliseconds', () => {
    const viejo = {
      ...INFORME,
      ventana: {
        ...INFORME.ventana,
        desde_ms: undefined,
        hasta_ms: undefined,
        desde_efectivo_ms: undefined,
      },
    }
    expect(ventanaDeInforme(viejo)).toEqual({
      desdeMs: Date.UTC(2026, 1, 3),
      hastaMs: Date.UTC(2026, 3, 19),
    })
  })

  it('opens on the last ten days and pages with at least 500 candles', () => {
    expect(velasIniciales('15m')).toBe(960)
    expect(velasIniciales('1h')).toBe(240)
    expect(velasIniciales('4h')).toBe(60)
    expect(velasIniciales('1d')).toBe(10)
    expect(velasPorPagina('1h')).toBe(500)
    expect(velasPorPagina('15m')).toBe(960)
  })
})

describe('pairing the trades of the official and the variant', () => {
  it('pairs by entry instant and side; each side keeps hours and net', () => {
    const pares = emparejar(
      informe(
        [op(0, 20, 'LONG', 30)],
        [op(0, 18, 'LONG', 20, 'maestro_vuelta')],
      ),
    )
    expect(pares).toHaveLength(1)
    expect(pares[0]).toMatchObject({
      lado: 'LONG',
      entradaMs: T0,
      oficial: { salidaMs: T0 + 20 * H, netoUsd: 30, horas: 20 },
      variante: { salidaMs: T0 + 18 * H, netoUsd: 20, horas: 18 },
    })
  })

  it('marks the variant as cut only when the time cap closed it earlier than the official', () => {
    const [cortada, otra, igual] = emparejar(
      informe(
        [
          op(0, 36, 'LONG', 10, 'tiempo'),
          op(50, 20, 'SHORT', 5),
          op(100, 30, 'LONG', 5, 'tiempo'),
        ],
        [
          op(0, 30, 'LONG', 4, 'tiempo'),
          op(50, 10, 'SHORT', 2, 'maestro_vuelta'),
          op(100, 30, 'LONG', 5, 'tiempo'),
        ],
      ),
    )
    expect(cortada!.variante!.cortada).toBe(true)
    expect(cortada!.oficial!.cortada).toBe(false)
    expect(otra!.variante!.cortada).toBe(false)
    expect(igual!.variante!.cortada).toBe(false)
  })

  it('keeps trades that only one of them took, and the same instant on opposite sides apart', () => {
    const pares = emparejar(
      informe(
        [op(0, 5, 'LONG', 1), op(10, 5, 'SHORT', 1)],
        [op(0, 5, 'SHORT', 1), op(20, 5, 'LONG', 1)],
      ),
    )
    expect(pares.map((p) => [p.lado, !!p.oficial, !!p.variante])).toEqual([
      ['LONG', true, false],
      ['SHORT', false, true],
      ['SHORT', true, false],
      ['LONG', false, true],
    ])
  })

  it('pairs two parallel positions that opened in the same candle one by one', () => {
    const pares = emparejar(
      informe(
        [op(0, 5, 'LONG', 1), op(0, 9, 'LONG', 2)],
        [op(0, 5, 'LONG', 1), op(0, 9, 'LONG', 2)],
      ),
    )
    expect(pares).toHaveLength(2)
    expect(new Set(pares.map((p) => p.id)).size).toBe(2)
    expect(pares.every((p) => p.oficial && p.variante)).toBe(true)
  })
})

describe('what is drawn for the checkboxes', () => {
  const pares = emparejar(
    informe(
      [op(0, 36, 'LONG', 10, 'tiempo'), op(50, 5, 'SHORT', 1)],
      [op(0, 30, 'LONG', 4, 'tiempo'), op(50, 5, 'SHORT', 1)],
    ),
  )

  it('draws a line and a closing mark per visible configuration, a cut mark for the cut variant', () => {
    const [primera] = marcas(pares, VISIBLES)
    expect(primera!.tramos).toEqual([
      { quien: 'oficial', salidaMs: T0 + 36 * H, cortada: false },
      { quien: 'variante', salidaMs: T0 + 30 * H, cortada: true },
    ])
  })

  it('hides a configuration with its checkbox and keeps the entry only while one is visible', () => {
    expect(
      marcas(pares, { oficial: true, variante: false })[0]!.tramos,
    ).toEqual([{ quien: 'oficial', salidaMs: T0 + 36 * H, cortada: false }])
    expect(
      marcas(pares, { oficial: false, variante: true })[0]!.tramos,
    ).toHaveLength(1)
    expect(marcas(pares, { oficial: false, variante: false })).toEqual([])
  })

  it('does not draw an entry for a trade only the hidden configuration took', () => {
    const solo = emparejar(informe([], [op(0, 5, 'LONG', 1)]))
    expect(marcas(solo, { oficial: true, variante: false })).toEqual([])
  })
})

describe('projection on the chart', () => {
  const velas: Vela[] = Array.from({ length: 48 }, (_, i) => ({
    t: T0 + i * H,
    o: 100 + i,
    h: 110 + i,
    l: 90 + i,
    c: 105 + i,
    v: 1,
  }))
  const mapa: MapaProyeccion = {
    ancho: 1000,
    alto: 400,
    tiempo: (ms) => (ms - T0) / 1000 / 60,
    precio: (p) => 400 - p,
  }
  const pares = emparejar(
    informe(
      [op(2, 10, 'LONG', 30)],
      [op(2, 6, 'LONG', 20, 'tiempo'), op(30, 4, 'SHORT', 1)],
    ),
  )

  it('takes the entry price from the close of the candle that contains the entry', () => {
    expect(precioEnVela(velas, T0 + 2 * H + 1000, H)).toBe(107)
    expect(precioEnVela(velas, T0 - H, H)).toBeNull()
    expect(precioEnVela(velas, T0 + 48 * H, H)).toBeNull()
  })

  it('puts the entry at the entry instant and the price, the variant line a few pixels under the official', () => {
    const [item] = proyectar(marcas(pares, VISIBLES), velas, H, mapa)
    expect(item).toMatchObject({ lado: 'LONG', x: 120 })
    const oficial = item!.tramos.find((t) => t.quien === 'oficial')!
    const variante = item!.tramos.find((t) => t.quien === 'variante')!
    expect(item!.y).toBe(400 - 107)
    expect(oficial.y).toBe(item!.y)
    expect(variante.y).toBe(item!.y + 4)
    expect(oficial.x2).toBeGreaterThan(variante.x2)
    expect(variante.cortada).toBe(true)
  })

  it('leaves out trades whose entry candle is not loaded yet, or that are off the visible area', () => {
    const ancho = { ...mapa, ancho: 3000 }
    const items = proyectar(marcas(pares, VISIBLES), velas.slice(10), H, ancho)
    expect(items.map((i) => i.par.entradaMs)).toEqual([T0 + 30 * H])
    const lejos = proyectar(marcas(pares, VISIBLES), velas, H, {
      ...ancho,
      tiempo: (ms) => (ms - T0) / 1000 / 60 + 5000,
    })
    expect(lejos).toEqual([])
  })

  it('finds the trade under the pointer, the nearest line when two overlap, and nothing far away', () => {
    const items = proyectar(marcas(pares, VISIBLES), velas, H, mapa)
    const [item] = items
    const x = (item!.x + item!.tramos[0]!.x2) / 2
    expect(buscarOperacion(items, x, item!.y)?.par).toBe(item!.par)
    expect(buscarOperacion(items, x, item!.y + 4)?.par).toBe(item!.par)
    expect(buscarOperacion(items, x, item!.y + 40)).toBeNull()
    expect(buscarOperacion(items, item!.x - 40, item!.y)).toBeNull()
  })
})

describe('tooltip', () => {
  it('shows side, date, hours and net of both configurations and says when the variant cut it', () => {
    const [par] = emparejar(
      informe(
        [op(0, 36, 'LONG', 10.5, 'tiempo')],
        [op(0, 30, 'LONG', -4.25, 'tiempo')],
      ),
    )
    expect(contenidoTooltip(par!, VISIBLES)).toEqual({
      titulo: '▲ LONG · 10 feb 12:00',
      filas: [
        {
          quien: 'oficial',
          etiqueta: 'Oficial · 36,0 h',
          neto: '+10,50 US$',
          tono: 'long',
        },
        {
          quien: 'variante',
          etiqueta: 'Variante · 30,0 h',
          neto: '−4,25 US$',
          tono: 'short',
        },
      ],
      aviso: 'La variante la cortó por el tope de horas',
    })
  })

  it('lists only the visible configurations, SHORT with ▼, and says who did not trade', () => {
    const [par] = emparejar(informe([op(0, 5, 'SHORT', 1)], []))
    expect(contenidoTooltip(par!, VISIBLES)).toMatchObject({
      titulo: '▼ SHORT · 10 feb 12:00',
      filas: [
        { quien: 'oficial', neto: '+1,00 US$' },
        { quien: 'variante', etiqueta: 'Variante · no operó', neto: '—' },
      ],
    })
    expect(
      contenidoTooltip(par!, { oficial: true, variante: false }).filas,
    ).toHaveLength(1)
    expect(contenidoTooltip(par!, VISIBLES).aviso).toBeUndefined()
  })
})
