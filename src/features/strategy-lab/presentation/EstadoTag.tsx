import type { EstadoVariante } from '../domain/estrategias-estado.ts'
import { TAG } from './estrategias-styles.ts'

/** The status of a variant as a small pill. */
export default function EstadoTag({ estado }: { estado: EstadoVariante }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-full px-2 text-badge leading-normal font-medium whitespace-nowrap ${TAG[estado.tono]}`}
    >
      {estado.texto}
    </span>
  )
}
