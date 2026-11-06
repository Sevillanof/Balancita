import {
  curvaSaldo,
  dominioDeCurvas,
  posicion,
  puntosSvg,
} from '../domain/estrategias-curva.ts'
import { firmado } from '../domain/estrategias-format.ts'
import type { Informe } from '../infrastructure/estrategias-api.ts'

const ANCHO = 1000
const ALTO = 300

/** Instants of the window the curves share: the effective start and the end the server measured to. */
function ventana(informe: Informe): [number, number] {
  const todas = [
    ...informe.oficial.operaciones,
    ...informe.variante.operaciones,
  ]
  const primera = Math.min(...todas.map((o) => o.entrada_ms))
  const ultima = Math.max(...todas.map((o) => o.salida_ms))
  return [
    informe.ventana.desde_efectivo_ms ??
      informe.ventana.desde_ms ??
      (Number.isFinite(primera) ? primera : 0),
    informe.ventana.hasta_ms ?? (Number.isFinite(ultima) ? ultima : 1),
  ]
}

function Etiqueta({
  saldo,
  top,
  arriba,
  color,
}: {
  saldo: number
  top: number
  arriba: boolean
  color: string
}) {
  return (
    <span
      className={`absolute right-1 font-mono text-hint ${color} ${arriba ? '-translate-y-full' : 'translate-y-1'}`}
      style={{ top: `${(top / ALTO) * 100}%` }}
    >
      {firmado(saldo)}
    </span>
  )
}

/**
 * «Saldo acumulado»: the net after costs piling up trade by trade, the official Terminal against the
 * variant, on one shared scale. Inline SVG stretched to the free height; the numbers are HTML so they
 * do not stretch with it.
 */
export default function CurvaSaldo({ informe }: { informe: Informe }) {
  const [desde, hasta] = ventana(informe)
  const oficial = curvaSaldo(informe.oficial.operaciones, desde, hasta)
  const variante = curvaSaldo(informe.variante.operaciones, desde, hasta)
  const dominio = dominioDeCurvas([oficial, variante])
  const cero = posicion(0, 0, dominio, ANCHO, ALTO).y
  const finOficial = oficial[oficial.length - 1].y
  const finVariante = variante[variante.length - 1].y
  const yOficial = posicion(0, finOficial, dominio, ANCHO, ALTO).y
  const yVariante = posicion(0, finVariante, dominio, ANCHO, ALTO).y
  return (
    <figure className="m-0 flex min-h-48 flex-1 flex-col rounded-control border border-solid border-line px-4 pt-3 pb-2">
      <figcaption className="flex gap-4 text-hint text-ink-2">
        <span className="font-mono">Saldo acumulado</span>
        <span className="flex items-center gap-1.5">
          <i
            className="h-0.75 w-3.5 rounded-swatch bg-info"
            aria-hidden="true"
          />
          Oficial
        </span>
        <span className="flex items-center gap-1.5">
          <i
            className="h-0.75 w-3.5 rounded-swatch bg-warn"
            aria-hidden="true"
          />
          Variante
        </span>
      </figcaption>
      <div className="relative min-h-0 flex-1">
        <svg
          role="img"
          aria-label="Saldo acumulado de la oficial y de la variante a lo largo de la ventana"
          viewBox={`0 0 ${ANCHO} ${ALTO}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <line
            x1={0}
            x2={ANCHO}
            y1={cero}
            y2={cero}
            className="stroke-line-strong"
            strokeDasharray="3 4"
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={puntosSvg(variante, dominio, ANCHO, ALTO)}
            className="fill-none stroke-warn"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={puntosSvg(oficial, dominio, ANCHO, ALTO)}
            className="fill-none stroke-info"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <Etiqueta
          saldo={finOficial}
          top={yOficial}
          arriba={finOficial >= finVariante}
          color="text-info"
        />
        <Etiqueta
          saldo={finVariante}
          top={yVariante}
          arriba={finVariante > finOficial}
          color="text-warn"
        />
      </div>
    </figure>
  )
}
