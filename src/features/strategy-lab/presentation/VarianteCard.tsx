import {
  estadoVariante,
  segundosCorriendo,
  tonoDeSigno,
} from '../domain/estrategias-estado.ts'
import { segmentosCambios, usd } from '../domain/estrategias-format.ts'
import type {
  EstrategiaFila,
  Perilla,
  Trabajo,
} from '../infrastructure/estrategias-api.ts'
import EstadoTag from './EstadoTag.tsx'
import { TEXTO_TONO } from './estrategias-styles.ts'

type Props = {
  fila: EstrategiaFila
  perillas: Perilla[]
  trabajo: Trabajo | null | undefined
  actual: boolean
  onElegir: () => void
}

function Resultado({ trabajo }: { trabajo: Trabajo | null | undefined }) {
  if (trabajo?.estado === 'corriendo') {
    const segundos = segundosCorriendo(trabajo)
    return (
      <span className="text-ink-2">
        corriendo{segundos === null ? '' : ` · ${segundos} s`}
      </span>
    )
  }
  const informe = trabajo?.informe
  if (!informe) return <span className="text-ink-2">—</span>
  const diferencia = informe.diferencia.neto_usd
  return (
    <span className="font-mono">
      {informe.variante.metricas.operaciones} ops ·{' '}
      <span className={TEXTO_TONO[tonoDeSigno(diferencia)]}>
        {usd(diferencia)}
      </span>{' '}
      vs oficial
    </span>
  )
}

/** One variant in the list: name, status, what it changes and the summary of its backtest. */
export default function VarianteCard({
  fila,
  perillas,
  trabajo,
  actual,
  onElegir,
}: Props) {
  const estado = estadoVariante(fila, trabajo)
  const cambios = segmentosCambios(fila.cambios, perillas)
  return (
    <li className="m-0 list-none p-0">
      <button
        type="button"
        aria-current={actual ? 'true' : undefined}
        onClick={onElegir}
        className={`grid w-full cursor-pointer gap-1.5 rounded-control border border-solid p-4 text-left text-ink ${actual ? 'border-info bg-surface-2' : 'border-line bg-surface-1'}`}
      >
        <span className="flex items-center justify-between gap-2 font-semibold">
          <span className="min-w-0 wrap-anywhere">{fila.nombre}</span>
          <EstadoTag estado={estado} />
        </span>
        <span className="text-hint text-ink-2">
          {cambios.length === 0
            ? 'Sin cambios'
            : cambios.map((cambio, i) => (
                <span key={cambio.clave}>
                  {i > 0 && ' · '}
                  {cambio.etiqueta} {cambio.hoy} →{' '}
                  <b className="font-semibold text-ink">{cambio.nuevo}</b>
                </span>
              ))}
        </span>
        <span className="flex justify-between gap-2 text-note">
          <span className="text-ink-2">Backtest</span>
          <Resultado trabajo={trabajo} />
        </span>
      </button>
    </li>
  )
}
