import {
  pasoEjeHoras,
  ticksDePrecio,
  ticksEjeMadrid,
  type Vela,
} from '../domain/estrategias-velas.ts'
import { numero } from '../domain/estrategias-format.ts'
import { ALTO_PILDORA, COLOR, anchoPildora } from './velas-geometria.ts'

/** Pieces both views of the trade chart share: an SVG drawn in pixels, with the tokens of the project as CSS variables. */

export function Pildora({
  x0,
  y,
  texto,
  color,
  prueba,
}: {
  x0: number
  y: number
  texto: string
  color: string
  prueba?: string
}) {
  const ancho = anchoPildora(texto)
  return (
    <g data-testid={prueba}>
      <rect
        x={x0}
        y={y - ALTO_PILDORA / 2}
        width={ancho}
        height={ALTO_PILDORA}
        rx={ALTO_PILDORA / 2}
        fill={COLOR.panel}
        stroke={color}
        strokeWidth={1.2}
      />
      <text
        x={x0 + ancho / 2}
        y={y + 4}
        textAnchor="middle"
        fill={color}
        fontSize={11.5}
        fontWeight={600}
        className="font-mono"
      >
        {texto}
      </text>
    </g>
  )
}

/** Horizontal price grid with its labels on the right and time labels (hours, or days at a long span) at the bottom. */
export function Ejes({
  ancho,
  areaAncho,
  yAxisTiempo,
  precioY,
  lo,
  hi,
  desdeMs,
  hastaMs,
  x,
  cadaHoras,
}: {
  ancho: number
  areaAncho: number
  yAxisTiempo: number
  precioY: (precio: number) => number
  lo: number
  hi: number
  desdeMs: number
  hastaMs: number
  x: (ms: number) => number
  cadaHoras?: number
}) {
  const ticks = ticksEjeMadrid(
    desdeMs,
    hastaMs,
    cadaHoras ?? pasoEjeHoras(hastaMs - desdeMs),
  )
  return (
    <g aria-hidden="true" className="font-mono" fontSize={11}>
      {ticksDePrecio(lo, hi).map((precio) => (
        <g key={precio}>
          <line
            x1={0}
            x2={areaAncho}
            y1={precioY(precio)}
            y2={precioY(precio)}
            stroke={COLOR.rejilla}
          />
          <text x={areaAncho + 8} y={precioY(precio) + 4} fill={COLOR.texto}>
            {numero(precio, 0)}
          </text>
        </g>
      ))}
      {ticks.map(({ ms, etiqueta }) => (
        <text
          key={ms}
          x={Math.min(ancho - 14, Math.max(14, x(ms)))}
          y={yAxisTiempo}
          textAnchor="middle"
          fill={COLOR.texto}
        >
          {etiqueta}
        </text>
      ))}
    </g>
  )
}

export function VelasSvg({
  velas,
  x,
  y,
  ancho,
  opacidad,
}: {
  velas: readonly Vela[]
  x: (ms: number) => number
  y: (precio: number) => number
  /** Body width in pixels. */
  ancho: number
  opacidad: number
}) {
  return (
    <g aria-hidden="true" data-testid="velas">
      {velas.map((vela) => {
        const color = vela.c >= vela.o ? COLOR.sube : COLOR.baja
        const cx = x(vela.t)
        return (
          <g key={vela.t}>
            <line
              x1={cx}
              x2={cx}
              y1={y(vela.h)}
              y2={y(vela.l)}
              stroke={color}
              strokeOpacity={opacidad}
            />
            <rect
              x={cx - ancho / 2}
              y={y(Math.max(vela.o, vela.c))}
              width={ancho}
              height={Math.max(1, Math.abs(y(vela.o) - y(vela.c)))}
              fill={color}
              fillOpacity={opacidad}
              rx={1}
            />
          </g>
        )
      })}
    </g>
  )
}
