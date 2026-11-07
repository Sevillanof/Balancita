import { describe, expect, it } from 'vitest'
import {
  TOPE_OFICIAL_MS,
  asignarCarriles,
  consultaDeRango,
  detalleDeOperacion,
  emparejar,
  mejoraDeSalida,
  operacionInicial,
  pasoEjeHoras,
  precioEnInstante,
  rangoDeCarga,
  rangoUna,
  rangoVarias,
  salidaIdeal,
  ticksDePrecio,
  topeVarianteDeInforme,
  ubicarPildoras,
  ventanaDeInforme,
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
  nocional?: number,
): Operacion => ({
  entrada_ms: T0 + entradaH * H,
  salida_ms: T0 + (entradaH + horas) * H,
  lado,
  neto_usd: neto,
  neto_bp: neto * 10,
  motivo,
  ...(nocional !== undefined && { nocional_usd: nocional }),
})

const informe = (oficial: Operacion[], variante: Operacion[]): Informe => ({
  ...INFORME,
  oficial: { ...INFORME.oficial, operaciones: oficial },
  variante: { ...INFORME.variante, operaciones: variante },
})

/** Hourly candles from `T0 + desdeH` h: open 100, high 100 + `alto`(i), low 100 − `bajo`(i), close 100. */
const velas = (
  desdeH: number,
  cuantas: number,
  alto: (i: number) => number = () => 1,
  bajo: (i: number) => number = () => 1,
): Vela[] =>
  Array.from({ length: cuantas }, (_, i) => ({
    t: T0 + (desdeH + i) * H,
    o: 100,
    h: 100 + alto(i),
    l: 100 - bajo(i),
    c: 100,
    v: 1,
  }))

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
})

describe('pairing the trades of the official and the variant', () => {
  it('pairs by entry instant and side; each side keeps hours, net, reason and size', () => {
    const pares = emparejar(
      informe(
        [op(0, 20, 'LONG', 30, 'maestro_vuelta', 330)],
        [op(0, 18, 'LONG', 20, 'maestro_vuelta', 300)],
      ),
    )
    expect(pares).toHaveLength(1)
    expect(pares[0]).toMatchObject({
      lado: 'LONG',
      entradaMs: T0,
      oficial: {
        salidaMs: T0 + 20 * H,
        netoUsd: 30,
        horas: 20,
        motivo: 'maestro_vuelta',
        nocionalUsd: 330,
      },
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

  it('flags the side that the end of the tested window closed, and only that one', () => {
    const [fin] = emparejar(
      informe(
        [op(0, 20, 'LONG', 3, 'fin_examen')],
        [op(0, 5, 'LONG', 1, 'maestro_vuelta')],
      ),
    )
    expect(fin!.oficial!.finVentana).toBe(true)
    expect(fin!.variante!.finVentana).toBeFalsy()
  })

  it('opens on the first trade the variant cut at or after the middle, else on the middle one', () => {
    const pares = emparejar(
      informe(
        [
          op(0, 10, 'LONG', 1),
          op(20, 36, 'LONG', 1, 'tiempo'),
          op(80, 10, 'LONG', 1),
          op(100, 36, 'LONG', 1, 'tiempo'),
        ],
        [
          op(0, 10, 'LONG', 1),
          op(20, 30, 'LONG', 1, 'tiempo'),
          op(80, 10, 'LONG', 1),
          op(100, 30, 'LONG', 1, 'tiempo'),
        ],
      ),
    )
    expect(operacionInicial(pares)).toBe(3)
    expect(operacionInicial(pares.slice(0, 3))).toBe(1)
    expect(operacionInicial([])).toBe(0)
  })

  it('reads the cap of hours the variant changed', () => {
    expect(topeVarianteDeInforme(INFORME)).toBe(30)
    expect(
      topeVarianteDeInforme({
        ...INFORME,
        estrategia: { ...INFORME.estrategia, cambios: { rebotes: { x: 1 } } },
      }),
    ).toBeNull()
  })
})

describe('price at an instant', () => {
  const lista: Vela[] = [
    { t: T0, o: 100, h: 120, l: 90, c: 110, v: 1 },
    { t: T0 + H, o: 110, h: 130, l: 105, c: 120, v: 1 },
  ]

  it('is the open at the candle start and moves to the close in proportion', () => {
    expect(precioEnInstante(lista, T0, H)).toBe(100)
    expect(precioEnInstante(lista, T0 + H / 2, H)).toBe(105)
    expect(precioEnInstante(lista, T0 + H, H)).toBe(110)
  })

  it('is null when no loaded candle holds the instant', () => {
    expect(precioEnInstante(lista, T0 - 1, H)).toBeNull()
    expect(precioEnInstante(lista, T0 + 2 * H, H)).toBeNull()
    expect(precioEnInstante([], T0, H)).toBeNull()
  })
})

describe('ideal exit: the best price within the official cap', () => {
  const entrada = (lado: 'LONG' | 'SHORT') => ({ ms: T0, px: 100, lado })

  it('LONG takes the highest high, the earliest one when it repeats', () => {
    const lista = velas(0, 40, (i) => (i === 5 || i === 9 ? 8 : 1))
    expect(salidaIdeal(lista, entrada('LONG'), H)).toEqual({
      salidaMs: T0 + 5 * H,
      precio: 108,
    })
  })

  it('SHORT takes the lowest low', () => {
    const lista = velas(
      0,
      40,
      () => 1,
      (i) => (i === 7 ? 12 : 2),
    )
    expect(salidaIdeal(lista, entrada('SHORT'), H)).toEqual({
      salidaMs: T0 + 7 * H,
      precio: 88,
    })
  })

  it('counts the last candle that closes at the 36 h cap and ignores the one that opens at it', () => {
    const dentro = velas(0, 60, (i) => (i === 35 ? 9 : 1))
    expect(salidaIdeal(dentro, entrada('LONG'), H)).toEqual({
      salidaMs: T0 + 35 * H,
      precio: 109,
    })
    const fuera = velas(0, 60, (i) => (i === 36 ? 50 : 1))
    const mejor = salidaIdeal(fuera, entrada('LONG'), H)!
    expect(mejor.precio).toBe(101)
    expect(mejor.salidaMs).toBeLessThan(T0 + TOPE_OFICIAL_MS)
    const bajo = velas(
      0,
      60,
      () => 1,
      (i) => (i === 36 ? 50 : 1),
    )
    expect(salidaIdeal(bajo, entrada('SHORT'), H)!.precio).toBe(99)
  })

  it('takes a candle only when it starts at the entry or later, apart from the one that holds the entry', () => {
    const antes = velas(-6, 40, (i) => (i < 6 ? 40 : 1))
    expect(salidaIdeal(antes, entrada('LONG'), H)).toEqual({
      salidaMs: T0,
      precio: 101,
    })
    const entraAMedias = { ms: T0 + H / 2, px: 104, lado: 'LONG' as const }
    const mitad = velas(0, 40, (i) => (i === 0 ? 30 : 1))
    // the candle that holds the entry only offers its close (100) and the entry price (104): its 130 may be from before
    expect(salidaIdeal(mitad, entraAMedias, H)).toEqual({
      salidaMs: T0 + H / 2,
      precio: 104,
    })
  })

  it('does not look past the cap with a different one, and answers null with nothing to look at', () => {
    const lista = velas(0, 20, (i) => i + 1)
    expect(salidaIdeal(lista, entrada('LONG'), H, 10 * H)!.precio).toBe(110)
    expect(salidaIdeal([], entrada('LONG'), H)).toBeNull()
    expect(salidaIdeal(velas(40, 5), entrada('LONG'), H)).toBeNull()
  })

  it('works with 4 h candles', () => {
    const lista: Vela[] = Array.from({ length: 12 }, (_, i) => ({
      t: T0 + i * 4 * H,
      o: 100,
      h: 100 + (i === 8 ? 20 : i),
      l: 90,
      c: 100,
      v: 1,
    }))
    // candle 8 opens at 32 h and closes at 36 h: inside the cap; candle 9 opens at 36 h: out
    expect(salidaIdeal(lista, entrada('LONG'), 4 * H)).toEqual({
      salidaMs: T0 + 32 * H,
      precio: 120,
    })
  })
})

describe('what moving the exit gains', () => {
  it('LONG gains when the exit is higher, SHORT when it is lower, with the size of the position', () => {
    expect(mejoraDeSalida(330, 'LONG', 100, 100, 109)).toBeCloseTo(29.7, 9)
    expect(mejoraDeSalida(330, 'SHORT', 100, 100, 91)).toBeCloseTo(29.7, 9)
    expect(mejoraDeSalida(200, 'LONG', 50, 52, 51)).toBeCloseTo(-4, 9)
    expect(mejoraDeSalida(200, 'SHORT', 100, 98, 98)).toBeCloseTo(0, 12)
  })
})

describe('the three exits of one trade', () => {
  const lista = velas(
    0,
    60,
    (i) => (i === 10 ? 9 : 1),
    (i) => (i === 14 ? 7 : 1),
  )

  it('keeps the recorded net of the official and the variant and prices the ideal with the size of the official one', () => {
    const [par] = emparejar(
      informe(
        [op(0, 20, 'LONG', 10, 'maestro_vuelta', 330)],
        [op(0, 18, 'LONG', 6, 'maestro_vuelta', 300)],
      ),
    )
    const d = detalleDeOperacion(par!, lista, H)!
    expect(d.entradaPx).toBe(100)
    expect(d.salidas.oficial).toMatchObject({
      quien: 'oficial',
      netoUsd: 10,
      horas: 20,
      salidaMs: T0 + 20 * H,
      precio: 100,
      motivo: 'regla de salida',
    })
    expect(d.salidas.variante).toMatchObject({ netoUsd: 6, horas: 18 })
    expect(d.salidas.ideal).toMatchObject({
      quien: 'ideal',
      salidaMs: T0 + 10 * H,
      precio: 109,
      horas: 10,
      motivo: 'mejor precio posible',
    })
    // the official net plus 330 US$ × (109 − 100) / 100: same size, same costs
    expect(d.salidas.ideal!.netoUsd).toBeCloseTo(10 + 29.7, 9)
    expect(d.faltoUsd).toBeCloseTo(29.7, 9)
  })

  it('SHORT looks for the lowest price', () => {
    const [par] = emparejar(
      informe([op(0, 20, 'SHORT', 1, 'maestro_vuelta', 200)], []),
    )
    const d = detalleDeOperacion(par!, lista, H)!
    expect(d.salidas.ideal).toMatchObject({ salidaMs: T0 + 14 * H, precio: 93 })
    expect(d.salidas.ideal!.netoUsd).toBeCloseTo(
      1 + (200 * (100 - 93)) / 100,
      9,
    )
    expect(d.faltoUsd).toBeCloseTo(14, 9)
  })

  it('explains each exit: the cap of the official, the cap of the variant, the same exit, or the rule', () => {
    const topes = { topeVarianteH: 30 }
    const [cortada, igual, regla, fin] = emparejar(
      informe(
        [
          op(0, 36, 'LONG', -2, 'tiempo', 300),
          op(2, 20, 'LONG', 1, 'tiempo', 300),
          op(4, 10, 'LONG', 1, 'maestro_vuelta', 300),
          op(6, 5, 'LONG', 1, 'fin_examen', 300),
        ],
        [
          op(0, 30, 'LONG', -1, 'tiempo', 300),
          op(2, 20, 'LONG', 1, 'tiempo', 300),
          op(4, 7, 'LONG', 1, 'maestro_vuelta', 300),
          op(6, 5, 'LONG', 1, 'fin_examen', 300),
        ],
      ),
    )
    const m = (par: typeof cortada) =>
      [
        detalleDeOperacion(par!, lista, H, topes)!.salidas.oficial!.motivo,
        detalleDeOperacion(par!, lista, H, topes)!.salidas.variante!.motivo,
      ] as const
    expect(m(cortada)).toEqual(['tope 36 h', 'tope 30 h'])
    expect(m(igual)).toEqual(['tope 36 h', 'igual que la oficial'])
    expect(m(regla)).toEqual(['regla de salida', 'regla de salida'])
    expect(m(fin)).toEqual(['fin de la ventana', 'igual que la oficial'])
  })

  it('keeps a missing side empty: no exit, no net, no «le faltó»', () => {
    const [solaVariante, solaOficial] = emparejar(
      informe(
        [op(30, 5, 'LONG', 1, 'maestro_vuelta', 300)],
        [op(0, 5, 'LONG', 1, 'maestro_vuelta', 300)],
      ),
    )
    const a = detalleDeOperacion(solaVariante!, lista, H)!
    expect(a.salidas.oficial).toBeNull()
    expect(a.salidas.variante).not.toBeNull()
    expect(a.salidas.ideal!.netoUsd).not.toBeNull()
    expect(a.faltoUsd).toBeNull()
    const b = detalleDeOperacion(solaOficial!, lista, H)!
    expect(b.salidas.variante).toBeNull()
    expect(b.faltoUsd).not.toBeNull()
  })

  it('never leaves the ideal under what the official got inside the cap, even in the candle the cap cuts', () => {
    const picos = velas(0, 60).map((v, i) =>
      i === 36 ? { ...v, h: 125, c: 120 } : v,
    )
    const [par] = emparejar(
      informe([op(0.5, 35.75, 'LONG', 3, 'tiempo', 300)], []),
    )
    const d = detalleDeOperacion(par!, picos, H)!
    // the candle that opens at 36 h only half belongs to the trade: it is out of the search, but the official got 105 in it
    expect(d.salidas.oficial!.precio).toBe(105)
    expect(d.salidas.ideal!.precio).toBe(105)
    expect(d.salidas.ideal!.salidaMs).toBe(par!.oficial!.salidaMs)
    expect(d.faltoUsd).toBe(0)
  })

  it('cannot price the ideal without the size, and the exits sit at the candle price', () => {
    const [par] = emparejar(
      informe([op(0, 20, 'LONG', 10)], [op(0, 18, 'LONG', 6)]),
    )
    const d = detalleDeOperacion(par!, lista, H)!
    expect(d.salidas.ideal!.netoUsd).toBeNull()
    expect(d.faltoUsd).toBeNull()
    expect(d.salidas.oficial!.precio).toBe(100)
  })

  it('is null when the entry candle is not loaded', () => {
    const [par] = emparejar(
      informe([op(0, 20, 'LONG', 10, 'maestro_vuelta', 300)], []),
    )
    expect(detalleDeOperacion(par!, velas(5, 10), H)).toBeNull()
  })
})

describe('which candles to ask for', () => {
  const [par] = emparejar(
    informe(
      [op(0, 20, 'LONG', 10, 'maestro_vuelta', 300)],
      [op(0, 18, 'LONG', 6)],
    ),
  )

  it('«Una operación» goes from ten hours before the entry to eight after the last exit', () => {
    expect(rangoUna(par!, T0 + 30 * H, H)).toEqual({
      desdeMs: T0 - 10 * H,
      hastaMs: T0 + 38 * H,
    })
    expect(rangoUna(par!, null, H).hastaMs).toBe(T0 + 28 * H)
  })

  it('«Varias» is five days centred on the entry', () => {
    expect(rangoVarias(par!, H)).toEqual({
      desdeMs: T0 - 60 * H,
      hastaMs: T0 + 60 * H,
    })
  })

  it('widens the margins at a coarse interval so that some candles remain around the trade', () => {
    expect(rangoUna(par!, null, 24 * H).desdeMs).toBe(T0 - 8 * 24 * H)
    expect(rangoVarias(par!, 24 * H).hastaMs).toBe(T0 + 20 * 24 * H)
  })

  it('loading covers both modes and the ideal up to the official cap', () => {
    expect(rangoDeCarga(par!, H)).toEqual({
      desdeMs: T0 - 60 * H,
      hastaMs: T0 + 60 * H,
    })
    const [larga] = emparejar(
      informe([op(0, 70, 'LONG', 1, 'maestro_vuelta')], []),
    )
    expect(rangoDeCarga(larga!, H).hastaMs).toBe(T0 + 78 * H)
  })

  it('asks the newest candles before the end of the range, never outside the tested window', () => {
    const ventana = { desdeMs: T0 - 1000 * H, hastaMs: T0 + 1000 * H }
    expect(consultaDeRango(rangoDeCarga(par!, H), ventana, H)).toEqual({
      antesMs: T0 + 60 * H,
      limite: 121,
    })
    expect(
      consultaDeRango(
        { desdeMs: T0 - 10 * H, hastaMs: T0 + 50 * H },
        { desdeMs: T0 - 5 * H, hastaMs: T0 + 20 * H },
        H,
      ),
    ).toEqual({ antesMs: T0 + 20 * H, limite: 26 })
    expect(
      consultaDeRango(
        { desdeMs: 0, hastaMs: 1e15 },
        { desdeMs: 0, hastaMs: 1e15 },
        900_000,
      ).limite,
    ).toBe(5000)
  })
})

describe('rows for the bars of «Varias»', () => {
  it('puts overlapping bars in different rows and reuses a row once its bar ended', () => {
    expect(
      asignarCarriles([
        { inicio: 0, fin: 10 },
        { inicio: 5, fin: 15 },
        { inicio: 10, fin: 20 },
        { inicio: 15, fin: 30 },
      ]),
    ).toEqual([0, 1, 0, 1])
  })

  it('never leaves two bars of one row touching, whatever the order they come in', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      inicio: (i * 37) % 200,
      fin: ((i * 37) % 200) + 5 + ((i * 11) % 40),
    }))
    const carriles = asignarCarriles(items)
    for (let a = 0; a < items.length; a++)
      for (let b = a + 1; b < items.length; b++)
        if (carriles[a] === carriles[b])
          expect(
            items[a]!.fin <= items[b]!.inicio ||
              items[b]!.fin <= items[a]!.inicio,
          ).toBe(true)
    expect(Math.max(...carriles)).toBeLessThan(items.length)
  })

  it('uses one row when nothing overlaps and answers [] for no bars', () => {
    expect(
      asignarCarriles([
        { inicio: 0, fin: 5 },
        { inicio: 5, fin: 8 },
      ]),
    ).toEqual([0, 0])
    expect(asignarCarriles([])).toEqual([])
  })
})

describe('pills of the exits', () => {
  const opciones = { alto: 20, ymin: 0, ymax: 400 }

  it('keeps a pill where it is when nothing is in the way', () => {
    expect(
      ubicarPildoras(
        [
          { x0: 0, ancho: 80, y: 100, hacia: 1 },
          { x0: 100, ancho: 80, y: 100, hacia: 1 },
        ],
        opciones,
      ),
    ).toEqual([100, 100])
  })

  it('moves a colliding pill the way it asked, so that no two overlap', () => {
    const entradas = [
      { x0: 50, ancho: 90, y: 200, hacia: -1 as const },
      { x0: 60, ancho: 90, y: 200, hacia: -1 as const },
      { x0: 70, ancho: 90, y: 205, hacia: -1 as const },
    ]
    const ys = ubicarPildoras(entradas, opciones)
    expect(ys[0]).toBe(200)
    expect(ys[1]).toBeLessThan(200)
    for (let a = 0; a < ys.length; a++)
      for (let b = a + 1; b < ys.length; b++)
        expect(Math.abs(ys[a]! - ys[b]!)).toBeGreaterThanOrEqual(20)
  })

  it('stays clear of the obstacles (the markers) as well', () => {
    const ys = ubicarPildoras([{ x0: 40, ancho: 90, y: 100, hacia: -1 }], {
      ...opciones,
      obstaculos: [{ x0: 80, ancho: 24, y: 100, alto: 24 }],
    })
    expect(ys[0]).toBeLessThan(100 - (24 + 20) / 2 + 1)
    const lejos = ubicarPildoras([{ x0: 200, ancho: 90, y: 100, hacia: -1 }], {
      ...opciones,
      obstaculos: [{ x0: 80, ancho: 24, y: 100, alto: 24 }],
    })
    expect(lejos).toEqual([100])
  })

  it('stays inside the bounds, going the other way when its own way is full', () => {
    const ys = ubicarPildoras(
      [
        { x0: 0, ancho: 90, y: 10, hacia: -1 },
        { x0: 0, ancho: 90, y: 10, hacia: -1 },
      ],
      { alto: 20, ymin: 0, ymax: 100 },
    )
    expect(ys[0]).toBe(10)
    expect(ys[1]).toBeGreaterThan(10)
    expect(ys.every((y) => y >= 0 && y <= 100)).toBe(true)
  })
})

describe('axes', () => {
  it('draws round prices inside the range', () => {
    expect(ticksDePrecio(2000, 2100)).toEqual([2000, 2020, 2040, 2060, 2080])
    expect(ticksDePrecio(10, 10)).toEqual([])
  })

  it('spaces the time labels by round hours so that there are at most nine', () => {
    expect(pasoEjeHoras(30 * H)).toBe(6)
    expect(pasoEjeHoras(120 * H)).toBe(24)
    expect(pasoEjeHoras(40 * 24 * H)).toBe(168)
  })
})
