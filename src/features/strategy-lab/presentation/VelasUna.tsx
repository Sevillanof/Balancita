import {
  rangoUna,
  ubicarPildoras,
  type DetalleOperacion,
  type Salida,
  type Vela,
} from '../domain/estrategias-velas.ts'
import { firmado, numero } from '../domain/estrategias-format.ts'
import {
  ALTO_PILDORA,
  COLOR,
  anchoPildora,
  escalaDeTiempo,
} from './velas-geometria.ts'
import { Ejes, Pildora, VelasSvg } from './velas-svg.tsx'

const MARGEN = { derecha: 66, abajo: 22, arriba: 16 }
const NOMBRE: Record<Salida, string> = {
  oficial: 'Oficial',
  variante: 'Variante',
  ideal: 'Ideal',
}
const ORDEN: Salida[] = ['oficial', 'variante', 'ideal']

const ESTRELLA =
  'M0 -11 l3.2 7.3 7.8 .6 -6 5.1 1.8 7.7 -6.8 -4.1 -6.8 4.1 1.8 -7.7 -6 -5.1 7.8 -.6z'

/**
 * «Una operación»: candles only around the trade (ten hours before the entry, eight after the last exit), a band while it
 * was open, a dashed line at the entry price with its pill, the entry triangle and one marker per exit —
 * Oficial ●, Variante ● and the Ideal ★ — each with a pill that carries its net US$. Pills never overlap.
 */
export default function VelasUna({
  velas,
  detalle,
  pasoMs,
  ancho,
  alto,
}: {
  velas: readonly Vela[]
  detalle: DetalleOperacion
  pasoMs: number
  ancho: number
  alto: number
}) {
  const { par, entradaPx, salidas } = detalle
  const rango = rangoUna(par, salidas.ideal?.salidaMs ?? null, pasoMs)
  const visibles = velas.filter(
    (v) => v.t >= rango.desdeMs && v.t <= rango.hastaMs,
  )
  const area = ancho - MARGEN.derecha
  const fondo = alto - MARGEN.abajo
  const fin = Math.max(
    par.entradaMs,
    ...ORDEN.map((q) => salidas[q]?.salidaMs ?? 0),
  )
  const { x, hueco } = escalaDeTiempo(
    rango.desdeMs,
    rango.hastaMs,
    pasoMs,
    area,
  )
  const precios = [
    entradaPx,
    ...ORDEN.flatMap((q) => (salidas[q] ? [salidas[q].precio] : [])),
    ...visibles.flatMap((v) => [v.h, v.l]),
  ]
  const margen = (Math.max(...precios) - Math.min(...precios)) * 0.12
  const lo = Math.min(...precios) - margen
  const hi = Math.max(...precios) + margen
  const y = (precio: number) =>
    MARGEN.arriba + ((hi - precio) / (hi - lo)) * (fondo - MARGEN.arriba)
  const X0 = x(par.entradaMs)
  const Y0 = y(entradaPx)
  const largo = par.lado === 'LONG'

  const textoEntrada = `entrada ${numero(entradaPx, 2)}`
  const existentes = ORDEN.flatMap((quien) => {
    const s = salidas[quien]
    return s ? [{ quien, s }] : []
  })
  const textos = existentes.map(
    ({ quien, s }) =>
      `${NOMBRE[quien]} ${s.netoUsd === null ? '—' : firmado(s.netoUsd, 1)}`,
  )
  const limite = (x0: number, anchoTexto: number) =>
    Math.max(2, Math.min(area - anchoTexto - 2, x0))
  const anchoEntrada = anchoPildora(textoEntrada)
  const pildoras = [
    {
      x0: limite(X0 - 10 - anchoEntrada, anchoEntrada),
      ancho: anchoEntrada,
      y: Y0,
      hacia: 1 as const,
    },
    ...existentes.map(({ s }, i) => {
      const Y = y(s.precio)
      const w = anchoPildora(textos[i]!)
      return {
        x0: limite(x(s.salidaMs) - w / 2, w),
        ancho: w,
        y: Y + (Y < Y0 ? -22 : 24),
        hacia: (Y < Y0 ? -1 : 1) as 1 | -1,
      }
    }),
  ]
  const ys = ubicarPildoras(pildoras, {
    // the outline of a pill is part of its box
    alto: ALTO_PILDORA + 3,
    ymin: MARGEN.arriba + ALTO_PILDORA / 2 + 2,
    ymax: fondo - ALTO_PILDORA / 2 - 2,
    // the markers of the exits and the entry triangle are not covered by a pill
    obstaculos: [
      ...existentes.map(({ s }) => ({
        x0: x(s.salidaMs) - 12,
        ancho: 24,
        y: y(s.precio),
        alto: 24,
      })),
      { x0: X0 - 10, ancho: 20, y: Y0 + (largo ? 12 : -12), alto: 20 },
    ],
  })

  return (
    <svg
      width={ancho}
      height={alto}
      viewBox={`0 0 ${ancho} ${alto}`}
      role="img"
      aria-label="Velas de ETH alrededor de la operación elegida con su entrada y la salida oficial, la de la variante y la ideal"
      className="absolute inset-0 overflow-hidden"
    >
      <Ejes
        ancho={ancho}
        areaAncho={area}
        yAxisTiempo={alto - 5}
        precioY={y}
        lo={lo}
        hi={hi}
        desdeMs={rango.desdeMs}
        hastaMs={rango.hastaMs}
        x={x}
        cadaHoras={pasoMs >= 4 * 3_600_000 ? undefined : 6}
      />
      <rect
        data-testid="banda-abierta"
        x={X0}
        y={MARGEN.arriba}
        width={Math.max(0, x(fin) - X0)}
        height={fondo - MARGEN.arriba}
        fill={COLOR.oficial}
        fillOpacity={0.08}
      />
      <VelasSvg
        velas={visibles}
        x={x}
        y={y}
        ancho={hueco * 0.62}
        opacidad={0.85}
      />
      <line
        data-testid="linea-entrada"
        x1={X0}
        x2={x(fin)}
        y1={Y0}
        y2={Y0}
        stroke={COLOR.tinta}
        strokeOpacity={0.8}
        strokeDasharray="5 4"
      />
      {existentes.map(({ quien, s }) => {
        const X = x(s.salidaMs)
        const Y = y(s.precio)
        return (
          <g
            key={quien}
            data-testid="salida"
            data-quien={quien}
            data-precio={s.precio}
          >
            <line
              x1={X}
              x2={X}
              y1={Y0}
              y2={Y}
              stroke={COLOR[quien]}
              strokeWidth={2}
              strokeDasharray="3 3"
            />
            {quien === 'ideal' ? (
              <path
                d={ESTRELLA}
                transform={`translate(${X} ${Y})`}
                fill={COLOR.ideal}
                stroke={COLOR.fondo}
                strokeWidth={1}
              />
            ) : (
              <circle
                cx={X}
                cy={Y}
                r={7}
                fill={COLOR[quien]}
                stroke={COLOR.fondo}
                strokeWidth={2}
              />
            )}
          </g>
        )
      })}
      <path
        data-testid="entrada"
        d={
          largo
            ? `M${X0} ${Y0 + 5} l-9 15 h18 z`
            : `M${X0} ${Y0 - 5} l-9 -15 h18 z`
        }
        fill={largo ? 'var(--color-long)' : 'var(--color-short)'}
        stroke={COLOR.fondo}
        strokeWidth={1.5}
      />
      <Pildora
        x0={pildoras[0]!.x0}
        y={ys[0]!}
        texto={textoEntrada}
        color={COLOR.tinta2}
        prueba="pildora-entrada"
      />
      {existentes.map(({ quien }, i) => (
        <Pildora
          key={quien}
          x0={pildoras[i + 1]!.x0}
          y={ys[i + 1]!}
          texto={textos[i]!}
          color={COLOR[quien]}
          prueba={`pildora-${quien}`}
        />
      ))}
    </svg>
  )
}
