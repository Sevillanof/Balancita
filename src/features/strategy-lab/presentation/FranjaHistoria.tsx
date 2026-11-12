import { useMemo } from 'react'
import type { ParOperacion, Vela } from '../domain/estrategias-velas.ts'
import { resumenDePrecios } from '../domain/estrategias-repeticion.ts'
import { COLOR } from './velas-geometria.ts'
import { useTamano } from './use-tamano.ts'

const ALTO = 30

/**
 * The whole history in one strip under the chart: the price line, a hollow dot per official trade (bottom) and a filled one per
 * variant trade (top), the stretch the chart shows and the cursor; what lies after the cursor is shaded. Pressing it (or the
 * arrow keys) moves the replay to that instant.
 */
export default function FranjaHistoria({
  velas,
  pares,
  cursor,
  visibleDesde,
  onIr,
}: {
  velas: readonly Vela[]
  pares: readonly ParOperacion[]
  cursor: number
  /** First candle the chart shows. */
  visibleDesde: number
  onIr: (indice: number) => void
}) {
  const { caja, ancho } = useTamano()
  const total = velas.length
  const columnas = Math.max(2, Math.floor(ancho / 3))
  const linea = useMemo(() => {
    const precios = resumenDePrecios(velas, columnas)
    if (precios.length === 0) return ''
    const lo = Math.min(...precios)
    const hi = Math.max(...precios)
    return precios
      .map(
        (p, k) =>
          `${((k / (precios.length - 1)) * ancho).toFixed(1)},${(
            ALTO -
            6 -
            ((p - lo) / (hi - lo || 1)) * (ALTO - 12)
          ).toFixed(1)}`,
      )
      .join(' ')
  }, [velas, columnas, ancho])
  if (total < 2) return null
  const t0 = velas[0]!.t
  const span = velas[total - 1]!.t - t0 || 1
  const xDe = (ms: number) => ((ms - t0) / span) * ancho
  const xCursor = (cursor / (total - 1)) * ancho
  const xDesde = (visibleDesde / (total - 1)) * ancho
  const ir = (clientX: number, caja: HTMLElement) => {
    const { left, width } = caja.getBoundingClientRect()
    const fraccion = width > 0 ? (clientX - left) / width : 0
    onIr(Math.round(Math.max(0, Math.min(1, fraccion)) * (total - 1)))
  }
  return (
    <div
      ref={caja}
      role="slider"
      tabIndex={0}
      aria-label="Momento de la repetición"
      aria-valuemin={0}
      aria-valuemax={total - 1}
      aria-valuenow={cursor}
      data-testid="franja-historia"
      className="relative cursor-pointer rounded-sm bg-canvas"
      style={{ height: ALTO }}
      onClick={(evento) => ir(evento.clientX, evento.currentTarget)}
      onKeyDown={(evento) => {
        const paso = Math.max(1, Math.round(total / 100))
        if (evento.key === 'ArrowRight')
          onIr(Math.min(total - 1, cursor + paso))
        else if (evento.key === 'ArrowLeft') onIr(Math.max(0, cursor - paso))
        else return
        evento.preventDefault()
      }}
    >
      <svg width={ancho} height={ALTO} aria-hidden="true" className="block">
        <polyline
          points={linea}
          fill="none"
          stroke={COLOR.rejilla}
          strokeWidth={1.5}
        />
        <rect
          x={xCursor}
          y={0}
          width={Math.max(0, ancho - xCursor)}
          height={ALTO}
          fill="black"
          opacity={0.3}
        />
        <rect
          x={xDesde}
          y={1}
          width={Math.max(2, xCursor - xDesde)}
          height={ALTO - 2}
          rx={4}
          fill={COLOR.oficial}
          fillOpacity={0.14}
          stroke={COLOR.oficial}
        />
        {pares
          .filter((par) => par.entradaMs <= velas[cursor]!.t)
          .map((par) => (
            <g key={par.id}>
              {par.oficial && (
                <circle
                  cx={xDe(par.entradaMs)}
                  cy={ALTO - 6}
                  r={2.5}
                  fill="none"
                  stroke={COLOR.tinta2}
                />
              )}
              {par.variante && (
                <circle
                  cx={xDe(par.entradaMs)}
                  cy={6}
                  r={2.5}
                  fill={COLOR.sube}
                />
              )}
            </g>
          ))}
        <line
          x1={xCursor}
          x2={xCursor}
          y1={0}
          y2={ALTO}
          stroke={COLOR.oficial}
          strokeWidth={2}
        />
      </svg>
    </div>
  )
}
