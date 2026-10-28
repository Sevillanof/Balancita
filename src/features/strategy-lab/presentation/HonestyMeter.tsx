import type { HonestyMeter as Meter } from '../infrastructure/quick-api.ts'

const TONES: Record<
  Meter['semaforo'],
  { label: string; dot: string; box: string }
> = {
  verde: {
    label: 'Verde',
    dot: 'bg-long',
    box: 'border-long/40',
  },
  amarillo: {
    label: 'Amarillo',
    dot: 'bg-warn',
    box: 'border-warn/50',
  },
  rojo: {
    label: 'Rojo',
    dot: 'bg-short',
    box: 'border-short/50',
  },
}

const DAY = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})
const number = new Intl.NumberFormat('es-ES', { useGrouping: 'always' })
const day = (stamp: string) => DAY.format(new Date(`${stamp}T00:00:00Z`))

type Props = {
  meter: Meter | null | undefined
  /** A test is running: the meter shown is the one of the previous result. */
  stale?: boolean
  /** There is a result on screen but it was made before the meter existed. */
  missing?: boolean
}

/**
 * The honesty meter: how much of a result can be believed. A traffic light with the reason in one line and, below, the four
 * numbers behind it (attempts tried, share outside the fitting, practice/holdout, result corrected for the attempts).
 */
export default function HonestyMeter({ meter, stale, missing }: Props) {
  if (!meter) {
    return missing ? (
      <p className="text-note text-ink-2" data-testid="honestidad-sin-medidor">
        Este resultado es anterior al medidor de honestidad: volvé a probar para
        ver el semáforo.
      </p>
    ) : null
  }
  const tone = TONES[meter.semaforo]
  const rows: Array<[string, string]> = [
    [
      'Variantes probadas en total',
      `${number.format(meter.intentos)} (cada prueba nueva suma)`,
    ],
    [
      'Resultado fuera del período de ajuste',
      meter.fuera_del_ajuste_pct == null
        ? '—'
        : `${number.format(meter.fuera_del_ajuste_pct)} %${meter.medicion === 'honesta' ? ' (cada trimestre usa fórmulas ajustadas solo con lo anterior)' : ' (lo anterior a sep-2025 estaba dentro del ajuste)'}`,
    ],
    [
      'Período de práctica',
      `${meter.practica_usada ? 'ya usado' : 'sin usar'} para elegir reglas (${day(meter.practica.desde)} – ${day(meter.practica.hasta)})${meter.incluye_practica ? ' · este resultado lo incluye' : ''}`,
    ],
    [
      'Holdout (reserva final)',
      `${meter.holdout_intacto ? 'intacto' : 'TOCADO'} (desde ${day(meter.holdout_desde)})`,
    ],
    [
      'Resultado corregido por los intentos',
      meter.prob_no_es_suerte == null
        ? 'sin operaciones suficientes'
        : `${meter.operaciones != null ? `Sobre estas ${number.format(meter.operaciones)} operaciones: ` : ''}${number.format(Math.round(meter.prob_no_es_suerte * 100))} % de probabilidad de que no sea suerte${meter.prob_sin_descontar_intentos != null ? ` (sin descontar los intentos serían ${number.format(Math.round(meter.prob_sin_descontar_intentos * 100))} %)` : ''}`,
    ],
  ]
  return (
    <section
      aria-label="Medidor de honestidad"
      data-testid="honestidad"
      data-semaforo={meter.semaforo}
      className={`grid min-w-0 gap-2 rounded-lg border border-solid bg-canvas px-3.5 py-3 ${tone.box}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          aria-hidden="true"
          className={`inline-block size-3.5 shrink-0 rounded-full ${tone.dot}`}
        />
        <strong className="text-note text-ink">Medidor de honestidad</strong>
        <span className="text-note font-semibold text-ink">{tone.label}</span>
        <span className="min-w-0 flex-1 text-note text-ink-2">
          {meter.motivo}
          {stale && ' (resultado anterior)'}
        </span>
      </div>
      <details className="text-note text-ink-2">
        <summary className="cursor-pointer text-ink">Ver el detalle</summary>
        <dl className="m-0 mt-1.5 grid grid-cols-5 gap-x-3 gap-y-1">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="col-span-2 text-ink">{label}</dt>
              <dd className="col-span-3 m-0">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  )
}
