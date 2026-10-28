import type { ExigenciaLevels } from '../infrastructure/quick-api.ts'

/** The level paper operates with: the sliders start here, and it is marked on them. */
export const EXIGENCIA_PAPER = 5
export const EXIGENCIA_PAPER_LEVELS: ExigenciaLevels = {
  maestro: EXIGENCIA_PAPER,
  portero: EXIGENCIA_PAPER,
}

/** Share of the signals the maestro calls strong at each level (mirrors `STRONG_SHARE` in futures_qwen_exigencia.py). */
const MAESTRO_PARTES = [50, 40, 33, 28, 24, 20, 16, 12, 8, 5, 2]

/** Share of the strong signals the portero lets through at each level (`PORTERO_LOGIT`, measured on the practice; 0 = all). */
const PORTERO_SI = [100, 70, 55, 40, 28, 19, 13, 8, 4, 2, 0.7]

const MARKS = Array.from({ length: 11 }, (_, level) => level)

type Props = {
  value: ExigenciaLevels
  onChange: (next: ExigenciaLevels) => void
  disabled?: boolean
}

/**
 * How demanding the maestro and the portero are in a test, 0 (accepts almost everything, more trades) to 10 (very
 * demanding, fewer trades). Only changes the test being launched: paper keeps the level 5 (marked on each slider).
 */
export default function ExigenciaControl({ value, onChange, disabled }: Props) {
  const rows: Array<{
    key: keyof ExigenciaLevels
    label: string
    detail: string
  }> = [
    {
      key: 'maestro',
      label: 'Maestro',
      detail: `fuerte en el ${MAESTRO_PARTES[value.maestro]} % de las señales`,
    },
    {
      key: 'portero',
      label: 'Portero',
      detail: `dice que sí a ~${PORTERO_SI[value.portero]} % de las señales fuertes`,
    },
  ]
  const changed =
    value.maestro !== EXIGENCIA_PAPER || value.portero !== EXIGENCIA_PAPER
  return (
    <div
      role="group"
      aria-label="Exigencia de la prueba"
      data-testid="exigencia"
      className="grid min-w-0 gap-2 rounded-lg border border-solid border-line bg-canvas px-3.5 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <strong className="text-note text-ink">Exigencia de la prueba</strong>
        <span className="text-note text-ink-2">
          0 = más operaciones, 10 = solo las más claras · el {EXIGENCIA_PAPER}{' '}
          es lo que opera en paper
        </span>
      </div>
      {rows.map(({ key, label, detail }) => (
        <label
          key={key}
          className="grid grid-cols-[5rem_minmax(0,1fr)_2rem] items-center gap-x-3 gap-y-0.5 text-note text-ink"
        >
          <span>{label}</span>
          <span className="grid min-w-0">
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={value[key]}
              disabled={disabled}
              aria-valuetext={`${value[key]} de 10${value[key] === EXIGENCIA_PAPER ? ' (como en paper)' : ''}`}
              list={`exigencia-marcas-${key}`}
              onChange={(event) =>
                onChange({ ...value, [key]: Number(event.target.value) })
              }
            />
            <datalist id={`exigencia-marcas-${key}`}>
              {MARKS.map((mark) => (
                <option key={mark} value={mark} />
              ))}
            </datalist>
            <span
              aria-hidden="true"
              className="relative h-3 text-ink-2"
              style={{ fontSize: '0.7rem' }}
            >
              <span
                className="absolute -translate-x-1/2 font-semibold"
                style={{ left: `${EXIGENCIA_PAPER * 10}%` }}
              >
                ▲ paper
              </span>
            </span>
          </span>
          <strong className="text-right tabular-nums">{value[key]}</strong>
          <span />
          <span className="col-span-2 text-ink-2">{detail}</span>
        </label>
      ))}
      {changed && (
        <button
          type="button"
          className="cursor-pointer justify-self-start rounded-sm border border-solid border-line bg-transparent px-3 py-1 text-hint leading-normal text-ink"
          onClick={() => onChange({ ...EXIGENCIA_PAPER_LEVELS })}
        >
          Volver al nivel de paper (5 y 5)
        </button>
      )}
    </div>
  )
}
