import type {
  DetalleOperacion,
  Salida,
  SalidaDetalle,
} from '../domain/estrategias-velas.ts'
import { firmado, numero } from '../domain/estrategias-format.ts'
import { TEXTO_TONO } from './estrategias-styles.ts'
import { COLOR } from './velas-geometria.ts'

const FILAS: Array<{ quien: Salida; nombre: string }> = [
  { quien: 'oficial', nombre: 'Oficial' },
  { quien: 'variante', nombre: 'Variante' },
  { quien: 'ideal', nombre: 'Ideal' },
]

const tono = (valor: number | null) =>
  valor === null || valor === 0 ? 'neutral' : valor > 0 ? 'long' : 'short'

const usd1 = (valor: number | null) =>
  valor === null ? '—' : `${firmado(valor, 1)} US$`

const FILA =
  'flex flex-wrap items-center justify-between gap-x-2 rounded-control bg-surface-2 px-3 py-1'

function FilaSalida({
  nombre,
  quien,
  salida,
}: {
  nombre: string
  quien: Salida
  salida: SalidaDetalle | null
}) {
  return (
    <li className={FILA} data-testid={`salida-${quien}`}>
      <span className="flex items-center gap-1.5 text-note leading-5 text-ink">
        <i
          className="size-2.5 rounded-full"
          style={{ background: COLOR[quien] }}
          aria-hidden="true"
        />
        {nombre}
      </span>
      <b
        className={`text-right font-mono text-title leading-5 font-semibold ${TEXTO_TONO[tono(salida?.netoUsd ?? null)]}`}
      >
        {usd1(salida?.netoUsd ?? null)}
      </b>
      <span className="w-full text-hint leading-4 text-ink-2">
        {salida
          ? `${numero(salida.horas, 1)} h · ${salida.motivo}`
          : 'no operó'}
      </span>
    </li>
  )
}

/** The three exits of the chosen trade with their net, and what the official one left on the table against the ideal. */
export default function PanelSalidas({
  detalle,
}: {
  detalle: DetalleOperacion | null
}) {
  return (
    <ol
      aria-label="Resultado de cada salida"
      className="m-0 grid list-none content-start gap-1 p-0 from-1000:w-58 from-1000:shrink-0"
    >
      {FILAS.map(({ quien, nombre }) => (
        <FilaSalida
          key={quien}
          quien={quien}
          nombre={nombre}
          salida={detalle?.salidas[quien] ?? null}
        />
      ))}
      <li className="flex flex-wrap items-center justify-between gap-x-2 rounded-control border border-dashed border-line-strong px-3 py-1">
        <span className="text-note leading-5 text-ink-2">
          Le faltó a la oficial
        </span>
        <b className="text-right font-mono text-title leading-5 font-semibold text-ink">
          {usd1(detalle?.faltoUsd ?? null)}
        </b>
        <span className="w-full text-hint leading-4 text-ink-2">
          contra la ideal
        </span>
      </li>
    </ol>
  )
}
