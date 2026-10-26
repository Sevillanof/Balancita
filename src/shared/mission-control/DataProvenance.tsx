import { utcDateTime } from '../finance/format.ts'

export const PROVENANCE_UNAVAILABLE = 'No disponible'

type DataProvenanceProps = {
  /** Where the data comes from (a verifiable source name). */
  origin?: string | null
  /** Experiment that produced it. */
  experiment?: string | null
  /** Run it belongs to. */
  runId?: string | null
  /** When the fact happened, epoch ms. Never the receive time. */
  eventTime?: number | null
  /** When this client last received it, epoch ms. Never the event time. */
  receivedAt?: number | null
  /** Clock for the age; without it no age is shown. */
  now?: number
  label?: string
}

const known = (value: string | null | undefined) =>
  typeof value === 'string' && value.trim() !== '' ? value : null

const time = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? utcDateTime(value)
    : null

/**
 * Origin, experiment, run and age of a block of data. Anything that cannot be
 * verified reads «No disponible»: nothing is inferred or invented, and the
 * event time is kept apart from the last received update.
 */
export default function DataProvenance({
  origin,
  experiment,
  runId,
  eventTime,
  receivedAt,
  now,
  label = 'Procedencia de los datos',
}: DataProvenanceProps) {
  const received = time(receivedAt)
  const age =
    received !== null &&
    typeof now === 'number' &&
    typeof receivedAt === 'number'
      ? ` · hace ${Math.floor(Math.max(0, now - receivedAt) / 1_000)} s`
      : ''
  const rows: Array<[string, string | null]> = [
    ['Origen', known(origin)],
    ['Experimento', known(experiment)],
    ['Run', known(runId)],
    ['Hora del evento', time(eventTime)],
    ['Última actualización recibida', received && `${received}${age}`],
  ]
  return (
    <dl
      className="m-0 flex flex-wrap gap-x-5 gap-y-1 text-provenance text-ink-2"
      aria-label={label}
    >
      {rows.map(([name, value]) => (
        <div className="flex gap-1.5" key={name} data-known={value !== null}>
          <dt className="after:content-colon">{name}</dt>
          <dd className={`m-0${value === null ? ' italic' : ''}`}>
            {value ?? PROVENANCE_UNAVAILABLE}
          </dd>
        </div>
      ))}
    </dl>
  )
}
