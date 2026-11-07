import { useMemo, useState } from 'react'
import {
  INTERVALO_INICIAL,
  INTERVALOS_VELAS,
  detalleDeOperacion,
  emparejar,
  operacionInicial,
  rangoDeCarga,
  segundosDe,
  topeVarianteDeInforme,
  ventanaDeInforme,
} from '../domain/estrategias-velas.ts'
import { diaDeInstante, horaDeInstante } from '../domain/estrategias-format.ts'
import type {
  EstrategiasApi,
  Informe,
} from '../infrastructure/estrategias-api.ts'
import PanelSalidas from './PanelSalidas.tsx'
import VelasChart, { type ModoVelas } from './VelasChart.tsx'
import { COLOR } from './velas-geometria.ts'
import { TAG } from './estrategias-styles.ts'
import { useVelas } from './use-velas.ts'

type Props = { api: EstrategiasApi; informe: Informe }

const NAV =
  'inline-flex size-6.5 cursor-pointer items-center justify-center rounded-control border border-solid border-line bg-surface-2 p-0 text-title leading-none text-ink hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40'

const AYUDA: Record<ModoVelas, string> = {
  una: 'Zoom a la operación: salida oficial, variante e ideal. ‹ › para pasar de una a otra.',
  varias:
    'Varias operaciones: cada barra es una operación, de la entrada a la salida (verde ganó, roja perdió; raya ámbar = donde cortó la variante). Tocá una para hacer zoom.',
}

function Segmentado<T extends string>({
  nombre,
  opciones,
  valor,
  onElegir,
  relleno,
}: {
  nombre: string
  opciones: ReadonlyArray<{ id: T; texto: string }>
  valor: T
  onElegir: (id: T) => void
  relleno: 'info' | 'surface'
}) {
  return (
    <span
      role="group"
      aria-label={nombre}
      className="inline-flex rounded-control border border-solid border-line bg-surface-2 p-0.5"
    >
      {opciones.map(({ id, texto }) => (
        <button
          key={id}
          type="button"
          aria-pressed={valor === id}
          onClick={() => onElegir(id)}
          className={`h-5.5 cursor-pointer rounded-sm border-0 px-2.5 text-hint whitespace-nowrap ${
            relleno === 'surface' ? 'font-mono' : ''
          } ${
            valor !== id
              ? 'bg-transparent text-ink-2'
              : relleno === 'info'
                ? 'bg-info font-semibold text-canvas'
                : 'bg-line text-ink'
          }`}
        >
          {texto}
        </button>
      ))}
    </span>
  )
}

const MODOS: ReadonlyArray<{ id: ModoVelas; texto: string }> = [
  { id: 'una', texto: 'Una operación' },
  { id: 'varias', texto: 'Varias' },
]

const INTERVALOS = INTERVALOS_VELAS.map(({ id }) => ({ id, texto: id }))

/**
 * The trades of the official Terminal and the variant on ETH candles of the tested window, one at a time with the three exits
 * (official, variant and ideal) or several at once as bars. The window is the one of the informe: nothing before its start and
 * nothing from its end (the reserve is never reached) is shown or asked for.
 */
export default function VelasConOperaciones({ api, informe }: Props) {
  const [intervalo, setIntervalo] = useState(INTERVALO_INICIAL)
  const [modo, setModo] = useState<ModoVelas>('una')
  const pares = useMemo(() => emparejar(informe), [informe])
  const [elegido, setElegido] = useState(() => operacionInicial(pares))
  const indice = Math.min(elegido, Math.max(0, pares.length - 1))
  const par = pares[indice] ?? null
  const { desdeMs, hastaMs } = ventanaDeInforme(informe)
  const ventana = useMemo(() => ({ desdeMs, hastaMs }), [desdeMs, hastaMs])
  const pasoMs = segundosDe(intervalo) * 1000
  const rango = useMemo(
    () => (par ? rangoDeCarga(par, pasoMs) : null),
    [par, pasoMs],
  )
  const { velas, cargando, error } = useVelas(api, ventana, intervalo, rango)
  const topeVarianteH = topeVarianteDeInforme(informe)
  const detalle = useMemo(
    () =>
      par && !cargando
        ? detalleDeOperacion(par, velas, pasoMs, { topeVarianteH })
        : null,
    [par, velas, cargando, pasoMs, topeVarianteH],
  )
  const largo = par?.lado === 'LONG'
  const sinDibujo =
    !cargando &&
    !error &&
    par !== null &&
    (velas.length === 0 || (modo === 'una' && !detalle))
  return (
    <figure className="m-0 flex min-w-0 flex-1 flex-col gap-2 rounded-control border border-solid border-line px-4 pt-2.5 pb-2">
      <figcaption className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-hint text-ink-2">
        <button
          type="button"
          className={NAV}
          aria-label="Operación anterior"
          disabled={indice <= 0}
          onClick={() => setElegido(indice - 1)}
        >
          ‹
        </button>
        <span className="text-note font-semibold whitespace-nowrap text-ink">
          {par
            ? `Operación ${indice + 1} de ${pares.length}`
            : 'Sin operaciones'}
        </span>
        <button
          type="button"
          className={NAV}
          aria-label="Operación siguiente"
          disabled={indice >= pares.length - 1}
          onClick={() => setElegido(indice + 1)}
        >
          ›
        </button>
        {par && (
          <>
            <span
              className={`rounded-sm px-1.5 py-0.5 text-hint font-semibold whitespace-nowrap ${largo ? TAG.long : TAG.short}`}
            >
              {largo ? '▲ LONG' : '▼ SHORT'}
            </span>
            <span className="whitespace-nowrap">
              {`${diaDeInstante(par.entradaMs)} · entra ${horaDeInstante(par.entradaMs)}`}
            </span>
          </>
        )}
        <Segmentado
          nombre="Zoom"
          opciones={MODOS}
          valor={modo}
          onElegir={setModo}
          relleno="info"
        />
        <span
          aria-label="Leyenda"
          className="ml-auto flex gap-3 whitespace-nowrap"
        >
          {(
            [
              ['Oficial', COLOR.oficial],
              ['Variante', COLOR.variante],
              ['Ideal', COLOR.ideal],
            ] as const
          ).map(([nombre, color]) => (
            <span key={nombre} className="inline-flex items-center gap-1.5">
              <i
                className="size-2.5 rounded-full"
                style={{ background: color }}
                aria-hidden="true"
              />
              {nombre}
            </span>
          ))}
        </span>
      </figcaption>
      {error && (
        <p role="alert" className="m-0 text-note text-warn">
          No se pudieron leer las velas: {error}
        </p>
      )}
      <div className="flex flex-1 flex-col gap-4 from-1000:flex-row">
        <div className="relative flex min-h-64 min-w-0 flex-1 flex-col from-1000:min-h-0">
          <VelasChart
            modo={modo}
            velas={velas}
            pares={pares}
            indice={indice}
            detalle={detalle}
            pasoMs={pasoMs}
            onElegir={(i) => {
              setElegido(i)
              setModo('una')
            }}
          />
          {cargando && (
            <p className="pointer-events-none absolute inset-0 m-0 grid place-items-center text-note text-ink-2">
              Cargando velas…
            </p>
          )}
          {sinDibujo && (
            <p className="pointer-events-none absolute inset-0 m-0 grid place-items-center text-note text-ink-2">
              Sin velas en la ventana probada
            </p>
          )}
          {!par && !cargando && (
            <p className="pointer-events-none absolute inset-0 m-0 grid place-items-center text-note text-ink-2">
              Sin operaciones en la ventana probada
            </p>
          )}
        </div>
        <PanelSalidas detalle={detalle} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-hint text-ink-2">
        <span className="min-w-0 flex-1">{AYUDA[modo]}</span>
        <Segmentado
          nombre="Temporalidad"
          opciones={INTERVALOS}
          valor={intervalo}
          onElegir={setIntervalo}
          relleno="surface"
        />
      </div>
    </figure>
  )
}
