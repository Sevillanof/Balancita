import { abreviado, diaCorto, usd } from '../domain/estrategias-format.ts'
import type { Informe, Listado } from '../infrastructure/estrategias-api.ts'
import { EYEBROW } from './estrategias-styles.ts'

type Props = {
  snapshot: Listado['snapshot']
  /** Any finished comparison: the official run is the same in all of them. */
  informe: Informe | null
}

const texto = (valor: unknown) => (typeof valor === 'string' ? valor : null)
const entero = (valor: unknown) =>
  typeof valor === 'number' && Number.isInteger(valor) ? valor : null

/** The Terminal that trades today: version, hash, since when and its result on the honest window. */
export default function TerminalActivaCard({ snapshot, informe }: Props) {
  const version = entero(snapshot.origen?.version_id)
  const desde = texto(snapshot.origen?.activada_utc)
  const oficial = informe?.oficial.metricas
  return (
    <section
      aria-label="Terminal activa"
      className="grid gap-1.5 rounded-control border border-solid border-info/35 bg-info/10 p-4"
    >
      <p className={`${EYEBROW} text-info!`}>Terminal activa · la que opera</p>
      <div className="flex items-baseline justify-between gap-2">
        <b>{version === null ? 'Terminal' : `Versión ${version}`}</b>
        <span className="font-mono text-hint text-ink-2">
          {abreviado(snapshot.config_hash)}
          {desde && ` · desde ${diaCorto(desde)}`}
        </span>
      </div>
      {oficial && (
        <div className="flex justify-between gap-2 text-note">
          <span className="text-ink-2">Ventana honesta</span>
          <span className="font-mono">
            {oficial.operaciones} ops ·{' '}
            <span className={oficial.neto_usd < 0 ? 'text-short' : 'text-long'}>
              {usd(oficial.neto_usd)}
            </span>
          </span>
        </div>
      )}
    </section>
  )
}
