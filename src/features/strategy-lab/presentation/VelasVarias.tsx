import {
  asignarCarriles,
  precioEnInstante,
  rangoVarias,
  type ParOperacion,
  type Vela,
} from '../domain/estrategias-velas.ts'
import { firmado } from '../domain/estrategias-format.ts'
import { COLOR, escalaDeTiempo } from './velas-geometria.ts'
import { Ejes, VelasSvg } from './velas-svg.tsx'

const MARGEN = { derecha: 60, abajo: 22, arriba: 10 }
const ANCHO_MINIMO_BARRA = 8
const ANCHO_CARACTER = 7
const HUECO_ENTRE_BARRAS = 4
const ALTO_MAXIMO_BARRA = 30
const ALTO_MINIMO_BARRA = 12
const SEPARACION_CARRILES = 4
/** Time labels of the candles and the caption of the bars sit between the candles and the first row. */
const FRANJA_TITULO = 36
const ALTO_MINIMO_VELAS = 80

const finOficial = (par: ParOperacion) =>
  (par.oficial ?? par.variante)?.salidaMs ?? par.entradaMs

const resultado = (par: ParOperacion) =>
  (par.oficial ?? par.variante)?.netoUsd ?? 0

/**
 * «Varias»: about five days of candles centred on the chosen trade, and under them one rounded bar per trade — from its entry to
 * the official exit — laid in rows so that none overlaps another. Green if the official won, red if it lost, «▲/▼ net» as label,
 * an amber tick where the variant left at another moment, the chosen one outlined and a dotted line from each bar to its entry
 * price on the candles. Choosing a bar (click, Enter or Space) calls `onElegir`.
 */
export default function VelasVarias({
  velas,
  pares,
  indice,
  pasoMs,
  ancho,
  alto,
  onElegir,
}: {
  velas: readonly Vela[]
  pares: readonly ParOperacion[]
  /** The chosen trade, an index of `pares`. */
  indice: number
  pasoMs: number
  ancho: number
  alto: number
  onElegir: (indice: number) => void
}) {
  const elegida = pares[indice]!
  const rango = rangoVarias(elegida, pasoMs)
  const visibles = velas.filter(
    (v) => v.t >= rango.desdeMs && v.t <= rango.hastaMs,
  )
  const area = ancho - MARGEN.derecha
  const { x, hueco } = escalaDeTiempo(
    rango.desdeMs,
    rango.hastaMs,
    pasoMs,
    area,
  )
  const barras = pares
    .map((par, i) => ({ par, i }))
    .filter(
      ({ par }) =>
        finOficial(par) > rango.desdeMs && par.entradaMs < rango.hastaMs,
    )
    .map((barra) => {
      const x0 = x(barra.par.entradaMs)
      const x1 = x(finOficial(barra.par))
      const etiqueta = `${barra.par.lado === 'LONG' ? '▲' : '▼'} ${firmado(resultado(barra.par), 1)}`
      const anchoEtiqueta = etiqueta.length * ANCHO_CARACTER + 16
      const w = Math.max(ANCHO_MINIMO_BARRA, x1 - x0)
      const dentro = anchoEtiqueta <= w
      return {
        ...barra,
        x0,
        w,
        etiqueta,
        dentro,
        extremo: x0 + (dentro ? w : w + anchoEtiqueta) + HUECO_ENTRE_BARRAS,
      }
    })
  const carriles = asignarCarriles(
    barras.map((b) => ({ inicio: b.x0, fin: b.extremo })),
  )
  const filas = Math.max(1, ...carriles.map((c) => c + 1))
  // The candles take most of the height, but never so much that the last row of bars is cut off.
  const arribaAlto = Math.max(
    ALTO_MINIMO_VELAS,
    Math.min(
      Math.round(alto * 0.58),
      alto -
        FRANJA_TITULO -
        filas * (ALTO_MINIMO_BARRA + SEPARACION_CARRILES) -
        2,
    ),
  )
  const yBarras = arribaAlto + FRANJA_TITULO
  const altoBarra = Math.max(
    ALTO_MINIMO_BARRA,
    Math.min(
      ALTO_MAXIMO_BARRA,
      (alto - 2 - yBarras) / filas - SEPARACION_CARRILES,
    ),
  )
  const lo = Math.min(...visibles.map((v) => v.l), Infinity) * 0.999
  const hi = Math.max(...visibles.map((v) => v.h), -Infinity) * 1.001
  const hayVelas = visibles.length > 0 && hi > lo
  const y = (precio: number) =>
    MARGEN.arriba + ((hi - precio) / (hi - lo)) * (arribaAlto - MARGEN.arriba)

  return (
    <svg
      width={ancho}
      height={alto}
      viewBox={`0 0 ${ancho} ${alto}`}
      role="group"
      aria-label="Velas de ETH de unos cinco días con una barra por operación; elegí una barra para verla de cerca"
      className="absolute inset-0 overflow-hidden"
    >
      {hayVelas && (
        <>
          <Ejes
            ancho={ancho}
            areaAncho={area}
            yAxisTiempo={arribaAlto + 14}
            precioY={y}
            lo={lo}
            hi={hi}
            desdeMs={rango.desdeMs}
            hastaMs={rango.hastaMs}
            x={x}
            cadaHoras={pasoMs >= 4 * 3_600_000 ? undefined : 12}
          />
          <VelasSvg
            velas={visibles}
            x={x}
            y={y}
            ancho={hueco * 0.62}
            opacidad={0.75}
          />
        </>
      )}
      <text
        x={0}
        y={yBarras - 6}
        fill={COLOR.texto}
        fontSize={11}
        aria-hidden="true"
      >
        Operaciones (cada barra: de la entrada a la salida oficial)
      </text>
      {barras.map((b, k) => {
        const { par, i } = b
        const Y = yBarras + carriles[k]! * (altoBarra + SEPARACION_CARRILES)
        const gano = resultado(par) >= 0
        const color = gano ? COLOR.ideal : 'var(--color-short)'
        const esta = i === indice
        const precio = hayVelas
          ? precioEnInstante(velas, par.entradaMs, pasoMs)
          : null
        const variante = par.variante
        const otraSalida =
          variante && par.oficial && variante.salidaMs !== par.oficial.salidaMs
        const xv = variante ? x(variante.salidaMs) : 0
        const nombre = `Operación ${i + 1} de ${pares.length}: ${par.lado === 'LONG' ? 'LONG' : 'SHORT'}, ${firmado(resultado(par), 1)} US$`
        return (
          <g
            key={par.id}
            data-testid="barra-operacion"
            data-indice={i}
            data-elegida={esta}
            role="button"
            tabIndex={0}
            aria-label={nombre}
            aria-pressed={esta}
            className="cursor-pointer"
            onClick={() => onElegir(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onElegir(i)
              }
            }}
          >
            {precio !== null && (
              <>
                <line
                  x1={b.x0}
                  x2={b.x0}
                  y1={y(precio)}
                  y2={Y}
                  stroke={color}
                  strokeOpacity={0.35}
                  strokeDasharray="2 3"
                />
                <circle cx={b.x0} cy={y(precio)} r={3.5} fill={color} />
              </>
            )}
            <rect
              x={b.x0}
              y={Y}
              width={b.w}
              height={altoBarra}
              rx={6}
              fill={color}
              fillOpacity={esta ? 0.5 : 0.25}
              stroke={esta ? COLOR.tinta : color}
              strokeWidth={esta ? 2 : 1}
            />
            {otraSalida && (
              <line
                data-testid="corte-variante"
                x1={xv}
                x2={xv}
                y1={Y - 3}
                y2={Y + altoBarra + 3}
                stroke={COLOR.variante}
                strokeWidth={3}
              />
            )}
            <text
              x={b.x0 + (b.dentro ? 8 : b.w + 6)}
              y={Y + altoBarra / 2 + 4}
              fill={COLOR.tinta}
              fontSize={11.5}
              fontWeight={600}
              className="font-mono"
            >
              {b.etiqueta}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
