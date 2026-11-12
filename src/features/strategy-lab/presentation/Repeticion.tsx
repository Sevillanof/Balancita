import { useEffect, useMemo, useRef, useState } from 'react'
import {
  INTERVALO_INICIAL,
  INTERVALOS_VELAS,
  emparejar,
  segundosDe,
  ventanaDeInforme,
  type IntervaloVelas,
} from '../domain/estrategias-velas.ts'
import {
  TICK_MS,
  VELOCIDADES,
  VELOCIDAD_INICIAL,
  avanzar,
  tramoVisible,
  type Velocidad,
} from '../domain/estrategias-repeticion.ts'
import type {
  EstrategiasApi,
  Informe,
} from '../infrastructure/estrategias-api.ts'
import FranjaHistoria from './FranjaHistoria.tsx'
import GraficoRepeticion from './GraficoRepeticion.tsx'
import Segmentado from './Segmentado.tsx'
import { COLOR } from './velas-geometria.ts'
import { useTamano } from './use-tamano.ts'
import { useVelasVentana } from './use-velas-ventana.ts'

const BOTON =
  'inline-flex size-6.5 cursor-pointer items-center justify-center rounded-control border border-solid border-line bg-surface-2 p-0 text-title leading-none text-ink hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40'

const OPCIONES_VELOCIDAD = VELOCIDADES.map((v) => ({
  id: `x${v}`,
  texto: `x${v}`,
}))
const OPCIONES_INTERVALO = INTERVALOS_VELAS.filter(
  ({ id }) => id === '5m' || id === '15m' || id === '1h',
).map(({ id }) => ({ id, texto: id }))

type Props = { api: EstrategiasApi; informe: Informe }

/**
 * The replay of the tested window: the saved ETH candles of the comparison run one by one, as if live, with the trades of the
 * official Terminal and of the variant drawn when they happen (never before the cursor). It starts paused at the first candle;
 * ▶ plays it at «x1» (one candle per second) up to «x100». The strip under the chart holds the whole window and moves the cursor.
 */
export default function Repeticion({ api, informe }: Props) {
  const [intervalo, setIntervalo] = useState<IntervaloVelas>(INTERVALO_INICIAL)
  return (
    <figure className="m-0 flex min-h-96 min-w-0 flex-1 flex-col gap-2 rounded-control border border-solid border-line px-4 pt-2.5 pb-2">
      {/* Another interval is another list of candles: the player starts over, paused. */}
      <Reproductor
        key={intervalo}
        api={api}
        informe={informe}
        intervalo={intervalo}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-hint text-ink-2">
        <span className="min-w-0 flex-1">
          Corre vela por vela sin ver el futuro. Tocá la franja para ir a otro
          día.
        </span>
        <Segmentado
          nombre="Temporalidad"
          opciones={OPCIONES_INTERVALO}
          valor={intervalo}
          onElegir={setIntervalo}
          relleno="surface"
        />
      </div>
    </figure>
  )
}

function Reproductor({
  api,
  informe,
  intervalo,
}: Props & { intervalo: IntervaloVelas }) {
  const [velocidad, setVelocidad] = useState<Velocidad>(VELOCIDAD_INICIAL)
  const [jugando, setJugando] = useState(false)
  const [cursor, setCursor] = useState(0)
  const acumulado = useRef(0)
  const { desdeMs, hastaMs } = ventanaDeInforme(informe)
  const ventana = useMemo(() => ({ desdeMs, hastaMs }), [desdeMs, hastaMs])
  const pasoMs = segundosDe(intervalo) * 1000
  const pares = useMemo(() => emparejar(informe), [informe])
  const { velas, cargando, error, cargadas } = useVelasVentana(
    api,
    ventana,
    intervalo,
  )
  const { caja, ancho, alto } = useTamano()
  const ultima = Math.max(0, velas.length - 1)
  const actual = Math.min(cursor, ultima)

  useEffect(() => {
    if (!jugando || velas.length < 2) return
    const reloj = setInterval(() => {
      setCursor((antes) => {
        const paso = avanzar(
          Math.min(antes, velas.length - 1),
          acumulado.current,
          velocidad,
          velas.length,
        )
        acumulado.current = paso.acumulado
        if (paso.fin) setJugando(false)
        return paso.cursor
      })
    }, TICK_MS)
    return () => clearInterval(reloj)
  }, [jugando, velocidad, velas.length])

  const listo = !cargando && !error && velas.length > 1
  const alFinal = listo && actual >= ultima
  const ranuras = Math.floor((ancho - 60) / 7)
  const { desde } = tramoVisible(actual, velas.length, ranuras)
  const alternar = () => {
    if (alFinal) {
      setCursor(0)
      acumulado.current = 0
    }
    setJugando((antes) => !antes)
  }
  return (
    <>
      <figcaption className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-hint text-ink-2">
        <button
          type="button"
          className={BOTON}
          aria-label="Volver al principio"
          disabled={!listo || actual === 0}
          onClick={() => {
            setJugando(false)
            setCursor(0)
            acumulado.current = 0
          }}
        >
          ⏮
        </button>
        <button
          type="button"
          className={`${BOTON} ${jugando ? 'border-info! bg-info! text-canvas!' : ''}`}
          aria-label={jugando ? 'Pausar' : 'Reproducir'}
          aria-pressed={jugando}
          disabled={!listo}
          onClick={alternar}
        >
          {jugando ? '⏸' : '▶'}
        </button>
        <Segmentado
          nombre="Velocidad"
          opciones={OPCIONES_VELOCIDAD}
          valor={`x${velocidad}`}
          onElegir={(id) => setVelocidad(Number(id.slice(1)) as Velocidad)}
          relleno="info"
        />
        <span
          aria-label="Leyenda"
          className="ml-auto flex gap-3 whitespace-nowrap"
        >
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="12" aria-hidden="true">
              <path d="M7 1 l6 10 h-12z" fill={COLOR.sube} />
            </svg>
            Variante
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="12" aria-hidden="true">
              <path
                d="M7 1 l6 10 h-12z"
                fill="none"
                stroke={COLOR.tinta2}
                strokeWidth="1.6"
              />
            </svg>
            Oficial
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i
              className="size-2.5 rounded-full"
              style={{ background: COLOR.tinta }}
              aria-hidden="true"
            />
            Sale
          </span>
        </span>
      </figcaption>
      {error && (
        <p role="alert" className="m-0 text-note text-warn">
          No se pudieron leer las velas: {error}
        </p>
      )}
      <div ref={caja} className="relative min-h-80 min-w-0 flex-1">
        {listo && (
          <GraficoRepeticion
            velas={velas}
            pares={pares}
            cursor={actual}
            pasoMs={pasoMs}
            ancho={ancho}
            alto={alto}
          />
        )}
        {cargando && (
          <p className="pointer-events-none absolute inset-0 m-0 grid place-items-center text-note text-ink-2">
            Cargando velas… {cargadas > 0 ? cargadas : ''}
          </p>
        )}
        {!cargando && !error && velas.length < 2 && (
          <p className="pointer-events-none absolute inset-0 m-0 grid place-items-center text-note text-ink-2">
            Sin velas en la ventana probada
          </p>
        )}
      </div>
      {listo && (
        <FranjaHistoria
          velas={velas}
          pares={pares}
          cursor={actual}
          visibleDesde={desde}
          onIr={(indice) => {
            setCursor(indice)
            acumulado.current = 0
          }}
        />
      )}
    </>
  )
}
