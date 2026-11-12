import { useMemo } from 'react'
import { precioEnInstante, type Vela } from '../domain/estrategias-velas.ts'
import { diaDeInstante, horaDeInstante } from '../domain/estrategias-format.ts'
import {
  anchoVela,
  marcasHasta,
  tramoVisible,
  type MarcaOperacion,
} from '../domain/estrategias-repeticion.ts'
import type { ParOperacion } from '../domain/estrategias-velas.ts'
import { COLOR, escalaDeTiempo } from './velas-geometria.ts'
import { Ejes, Pildora, VelasSvg } from './velas-svg.tsx'

const MARGEN = { derecha: 60, abajo: 22, arriba: 10 }
/** How far under (LONG) or over (SHORT) the candle each mark sits; the variant's is the farther one so the two never overlap. */
const DISTANCIA = { oficial: 16, variante: 30 }

const triangulo = (x: number, y: number, abajo: boolean) =>
  abajo ? `M${x} ${y + 8} l7 -12 h-14 z` : `M${x} ${y - 8} l7 12 h-14 z`

/**
 * The candles of the replay up to the cursor (nothing after it: the right edge is the future, left empty) with the trades that
 * already happened at that instant: the official ones as hollow marks with a dashed line, the variant's as filled marks with a
 * solid one; a circle where each one left. A trade still open runs on to the cursor.
 */
export default function GraficoRepeticion({
  velas,
  pares,
  cursor,
  pasoMs,
  ancho,
  alto,
}: {
  velas: readonly Vela[]
  pares: readonly ParOperacion[]
  /** Index in `velas` of the last candle the replay has reached. */
  cursor: number
  pasoMs: number
  ancho: number
  alto: number
}) {
  const area = ancho - MARGEN.derecha
  const alturaVelas = alto - MARGEN.abajo
  const { desde, hasta, ranuras } = tramoVisible(
    cursor,
    velas.length,
    area / anchoVela(ancho),
  )
  const visibles = useMemo(
    () => velas.slice(desde, hasta + 1),
    [velas, desde, hasta],
  )
  const ultima = velas[hasta]
  const ahoraMs = ultima ? ultima.t + pasoMs : 0
  const marcas = useMemo(
    () => marcasHasta(pares, velas, pasoMs, ahoraMs),
    [pares, velas, pasoMs, ahoraMs],
  )
  if (!ultima || visibles.length === 0) return null
  const inicioMs = visibles[0]!.t
  const finMs = inicioMs + (ranuras - 1) * pasoMs
  const { x, hueco } = escalaDeTiempo(inicioMs, finMs, pasoMs, area)
  const lo = Math.min(...visibles.map((v) => v.l))
  const hi = Math.max(...visibles.map((v) => v.h))
  const holgura = (hi - lo) * 0.08 || 1
  const y = (precio: number) =>
    MARGEN.arriba +
    ((hi + holgura - precio) / (hi - lo + 2 * holgura)) *
      (alturaVelas - MARGEN.arriba)
  const visible = (m: MarcaOperacion) =>
    (m.salidaMs ?? ahoraMs) >= inicioMs && m.entradaMs <= ahoraMs
  const cursorX = x(ultima.t) + hueco / 2
  // Marks use the real instant (no clamping to the edges): a trade that began before the stretch enters from the left, cut by the clip.
  const total = finMs - inicioMs + pasoMs
  const xLibre = (ms: number) => (area * (ms - inicioMs)) / total + hueco / 2
  const idClip = 'recorte-repeticion'

  return (
    <svg
      width={ancho}
      height={alto}
      viewBox={`0 0 ${ancho} ${alto}`}
      role="img"
      aria-label="Velas de ETH con las operaciones hasta el instante de la repetición"
      className="block"
    >
      <Ejes
        ancho={ancho}
        areaAncho={area}
        yAxisTiempo={alto - 6}
        precioY={y}
        lo={lo - holgura}
        hi={hi + holgura}
        desdeMs={inicioMs}
        hastaMs={finMs}
        x={x}
      />
      <rect
        x={cursorX}
        y={MARGEN.arriba}
        width={Math.max(0, area - cursorX)}
        height={alturaVelas - MARGEN.arriba}
        fill={COLOR.fondo}
        opacity={0.55}
      />
      <VelasSvg
        velas={visibles}
        x={(ms) => x(ms)}
        y={y}
        ancho={Math.max(2, hueco * 0.62)}
        opacidad={1}
      />
      <clipPath id={idClip}>
        <rect
          x={0}
          y={MARGEN.arriba}
          width={area}
          height={alturaVelas - MARGEN.arriba}
        />
      </clipPath>
      <g data-testid="marcas" clipPath={`url(#${idClip})`}>
        {marcas.filter(visible).map((m) => {
          const color =
            m.quien === 'oficial'
              ? COLOR.tinta2
              : m.lado === 'LONG'
                ? COLOR.sube
                : COLOR.baja
          const velaEntrada = velas.find(
            (v) => v.t <= m.entradaMs && m.entradaMs < v.t + pasoMs,
          )
          const largo = m.lado === 'LONG'
          const xe = xLibre(m.entradaMs)
          const base = velaEntrada
            ? largo
              ? y(velaEntrada.l) + DISTANCIA[m.quien]
              : y(velaEntrada.h) - DISTANCIA[m.quien]
            : y(m.entradaPx)
          const xs = xLibre(m.salidaMs ?? ultima.t)
          const pxSalida =
            m.salidaPx ??
            precioEnInstante(velas, ultima.t, pasoMs) ??
            m.entradaPx
          return (
            <g key={m.id} data-testid={`marca-${m.quien}`}>
              <line
                x1={xe}
                y1={y(m.entradaPx)}
                x2={xs}
                y2={y(pxSalida)}
                stroke={color}
                strokeOpacity={m.quien === 'oficial' ? 0.9 : 0.55}
                strokeDasharray={m.quien === 'oficial' ? '3 3' : undefined}
              />
              <path
                d={triangulo(xe, base, !largo)}
                fill={m.quien === 'oficial' ? 'none' : color}
                stroke={color}
                strokeWidth={1.6}
              />
              {m.salidaMs !== null && (
                <circle
                  cx={xs}
                  cy={y(pxSalida)}
                  r={5}
                  fill={m.quien === 'oficial' ? 'none' : COLOR.tinta}
                  stroke={m.quien === 'oficial' ? color : COLOR.tinta}
                  strokeWidth={1.6}
                />
              )}
            </g>
          )
        })}
      </g>
      <line
        x1={cursorX}
        x2={cursorX}
        y1={MARGEN.arriba}
        y2={alturaVelas}
        stroke={COLOR.oficial}
        strokeWidth={1.5}
      />
      <Pildora
        x0={Math.max(2, Math.min(area - 90, cursorX - 90))}
        y={alturaVelas - 12}
        texto={`${diaDeInstante(ultima.t)} ${horaDeInstante(ultima.t)}`}
        color={COLOR.oficial}
        prueba="hora-repeticion"
      />
    </svg>
  )
}
