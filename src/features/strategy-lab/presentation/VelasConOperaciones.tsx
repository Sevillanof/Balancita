import { useMemo, useState } from 'react'
import {
  INTERVALO_INICIAL,
  INTERVALOS_VELAS,
  emparejar,
  ventanaDeInforme,
  type Visibilidad,
} from '../domain/estrategias-velas.ts'
import type {
  EstrategiasApi,
  Informe,
} from '../infrastructure/estrategias-api.ts'
import VelasChart from './VelasChart.tsx'
import { useVelas } from './use-velas.ts'

type Props = { api: EstrategiasApi; informe: Informe }

const CASILLA =
  'inline-flex cursor-pointer items-center gap-1 text-hint text-ink-2'

/**
 * The candles of ETH of the tested window with the trades of both configurations on top. The window is the one of the
 * informe: nothing before its start and nothing from its end (the reserve is never reached) is shown or asked for.
 */
export default function VelasConOperaciones({ api, informe }: Props) {
  const [intervalo, setIntervalo] = useState(INTERVALO_INICIAL)
  const [visibles, setVisibles] = useState<Visibilidad>({
    oficial: true,
    variante: true,
  })
  const { desdeMs, hastaMs } = ventanaDeInforme(informe)
  const ventana = useMemo(() => ({ desdeMs, hastaMs }), [desdeMs, hastaMs])
  const { velas, cargando, error, cargarAnteriores } = useVelas(
    api,
    ventana,
    intervalo,
  )
  const pares = useMemo(() => emparejar(informe), [informe])
  return (
    <figure className="m-0 flex min-h-72 min-w-0 flex-1 flex-col gap-2 rounded-control border border-solid border-line px-4 pt-3 pb-2">
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-hint text-ink-2">
        <span className="text-note font-semibold text-ink">ETH / USD</span>
        <span
          role="group"
          aria-label="Temporalidad"
          className="inline-flex rounded-control border border-solid border-line bg-surface-2 p-0.5"
        >
          {INTERVALOS_VELAS.map(({ id }) => (
            <button
              key={id}
              type="button"
              aria-pressed={intervalo === id}
              onClick={() => setIntervalo(id)}
              className={`h-5.5 cursor-pointer rounded-sm border-0 px-2 font-mono text-hint ${
                intervalo === id
                  ? 'bg-line text-ink'
                  : 'bg-transparent text-ink-2'
              }`}
            >
              {id}
            </button>
          ))}
        </span>
        <label className={CASILLA}>
          <input
            type="checkbox"
            className="m-0 accent-info"
            checked={visibles.oficial}
            onChange={(e) =>
              setVisibles((v) => ({ ...v, oficial: e.target.checked }))
            }
          />
          <i className="size-2.5 rounded-sm bg-info" aria-hidden="true" />
          Oficial
        </label>
        <label className={CASILLA}>
          <input
            type="checkbox"
            className="m-0 accent-info"
            checked={visibles.variante}
            onChange={(e) =>
              setVisibles((v) => ({ ...v, variante: e.target.checked }))
            }
          />
          <i className="size-2.5 rounded-sm bg-warn" aria-hidden="true" />
          Variante
        </label>
        <span className="ml-auto text-ink-2">
          ▲▼ entrada · ● cierre · ✕ cortada por el tope de horas · ○ cerrada al
          final de la ventana · arrastrá para ver más velas
        </span>
      </figcaption>
      {error && (
        <p role="alert" className="m-0 text-note text-warn">
          No se pudieron leer las velas: {error}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <VelasChart
          velas={velas}
          intervalo={intervalo}
          pares={pares}
          visibles={visibles}
          onReachStart={cargarAnteriores}
          ariaLabel="Velas de ETH con las operaciones de la oficial y de la variante"
        />
        {cargando && velas.length === 0 && (
          <p className="pointer-events-none absolute inset-0 m-0 grid place-items-center text-note text-ink-2">
            Cargando velas…
          </p>
        )}
        {!cargando && !error && velas.length === 0 && (
          <p className="pointer-events-none absolute inset-0 m-0 grid place-items-center text-note text-ink-2">
            Sin velas en la ventana probada
          </p>
        )}
      </div>
    </figure>
  )
}
