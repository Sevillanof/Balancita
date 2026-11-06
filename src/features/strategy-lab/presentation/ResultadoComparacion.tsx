import { useState } from 'react'
import { barrasDeNeto } from '../domain/estrategias-curva.ts'
import { tonoDeSigno } from '../domain/estrategias-estado.ts'
import { diaCorto, firmado, numero, usd } from '../domain/estrategias-format.ts'
import type { Informe } from '../infrastructure/estrategias-api.ts'
import CurvaSaldo from './CurvaSaldo.tsx'
import { BOTON, EYEBROW, TEXTO_TONO } from './estrategias-styles.ts'
import OperacionesModal from './OperacionesModal.tsx'

type Props = {
  informe: Informe
  ocupado: boolean
  onVolverACorrer: () => void
}

function Barra({
  quien,
  color,
  punto,
  operaciones,
  neto,
  largo,
}: {
  quien: string
  color: string
  punto: string
  operaciones: number
  neto: number
  largo: number
}) {
  return (
    <div className="flex items-center gap-3 text-note">
      <span className="flex w-24 shrink-0 items-center gap-1.5 text-ink-2">
        <i className={`size-2.5 rounded-sm ${punto}`} aria-hidden="true" />
        {quien}
      </span>
      <span className="h-6 min-w-0 flex-1 overflow-hidden rounded-control bg-line">
        <span
          className={`flex h-full min-w-8 items-center justify-end rounded-control px-2.5 ${color}`}
          style={{ width: `${largo}%` }}
        >
          <span
            className="font-mono text-hint font-semibold whitespace-nowrap text-canvas"
            title={`${operaciones} operaciones`}
          >
            {operaciones}
          </span>
        </span>
      </span>
      <span
        className={`w-32 shrink-0 text-right font-mono text-title font-semibold ${TEXTO_TONO[tonoDeSigno(neto)]}`}
      >
        {usd(neto)}
      </span>
    </div>
  )
}

function Tile({
  titulo,
  oficial,
  variante,
  delta,
  tono,
}: {
  titulo: string
  oficial: string
  variante: string
  delta: string
  tono: 'long' | 'short' | 'neutral'
}) {
  return (
    <div
      role="group"
      aria-label={titulo}
      className="grid gap-1.5 rounded-control bg-surface-2 px-4 py-3"
    >
      <span className={EYEBROW}>{titulo}</span>
      <div className="flex justify-between font-mono text-note">
        <span className="font-sans text-ink-2">oficial</span>
        <span>{oficial}</span>
      </div>
      <div className="flex justify-between font-mono text-note">
        <span className="font-sans text-ink-2">variante</span>
        <span>{variante}</span>
      </div>
      <span className={`font-mono text-hint font-medium ${TEXTO_TONO[tono]}`}>
        {delta}
      </span>
    </div>
  )
}

const pb = (v: number | null) => (v === null ? '—' : `${firmado(v, 1)} pb`)
const horas = (v: number | null) => (v === null ? '—' : `${numero(v, 1)} h`)
const pct = (v: number | null) => (v === null ? '—' : `${numero(v * 100, 0)} %`)
const dinero = (v: number | null) => (v === null ? '—' : `${numero(v)} US$`)

function Tiles({ informe }: { informe: Informe }) {
  const o = informe.oficial.metricas
  const v = informe.variante.metricas
  const d = informe.diferencia
  const caida = d.max_drawdown_usd
  return (
    <div className="grid grid-cols-2 gap-3 from-1100:grid-cols-4">
      <Tile
        titulo="Neto por operación"
        oficial={pb(o.neto_bp_por_operacion)}
        variante={pb(v.neto_bp_por_operacion)}
        delta={pb(d.neto_bp_por_operacion)}
        tono={tonoDeSigno(d.neto_bp_por_operacion)}
      />
      <Tile
        titulo="Acierto"
        oficial={pct(o.acierto)}
        variante={pct(v.acierto)}
        delta={d.acierto === null ? '—' : `${firmado(d.acierto * 100, 0)} pp`}
        tono={tonoDeSigno(d.acierto)}
      />
      <Tile
        titulo="Peor caída"
        oficial={dinero(o.max_drawdown_usd)}
        variante={dinero(v.max_drawdown_usd)}
        delta={
          caida === null
            ? '—'
            : `${firmado(caida)} US$ ${caida > 0 ? 'peor' : caida < 0 ? 'mejor' : 'igual'}`
        }
        tono={caida === null ? 'neutral' : tonoDeSigno(-caida)}
      />
      <Tile
        titulo="Horas promedio"
        oficial={horas(o.horas_promedio)}
        variante={horas(v.horas_promedio)}
        delta={
          d.horas_promedio === null ? '—' : `${firmado(d.horas_promedio, 1)} h`
        }
        tono="neutral"
      />
    </div>
  )
}

/** A condition of the test the backtest cannot reproduce shows struck through, with the reason on hover. */
const CONDICIONES = [
  {
    nombre: 'Noticias',
    patron: /noticias/i,
    ayuda: 'El backtest no reproduce noticias',
  },
  {
    nombre: 'Libro',
    patron: /libro/i,
    ayuda: 'Ejecuta por velas, no por libro de órdenes',
  },
  {
    nombre: 'Posicionamiento',
    patron: /posicionamiento/i,
    ayuda: 'Sin datos de posicionamiento',
  },
]

const CHIP =
  'inline-flex h-6.5 items-center gap-1.5 rounded-full px-2.5 text-hint'

function Condiciones({ informe }: { informe: Informe }) {
  const { ventana, limites } = informe
  const intacta = !ventana.reserva.incluida
  return (
    <ul
      aria-label="Condiciones de la prueba"
      className="m-0 flex list-none flex-wrap gap-2 p-0"
    >
      <li className={`${CHIP} bg-surface-2 text-ink-2`}>
        <span aria-hidden="true">◷</span>
        <span className="font-mono">
          {diaCorto(ventana.desde_efectivo)} → {diaCorto(ventana.hasta)}
        </span>
      </li>
      <li
        className={`${CHIP} ${intacta ? 'bg-long/15 text-long' : 'bg-warn/15 text-warn'}`}
        title={ventana.reserva.aviso}
      >
        <span aria-hidden="true">●</span>
        {intacta ? 'Reserva intacta' : 'Reserva incluida'}
      </li>
      {CONDICIONES.map((condicion) => {
        const fuera = limites.some((limite) => condicion.patron.test(limite))
        return fuera ? (
          <li
            key={condicion.nombre}
            className={`${CHIP} bg-surface-2 text-ink-2 line-through`}
            title={condicion.ayuda}
          >
            <span>{condicion.nombre}</span>
            <span className="sr-only">: no incluido</span>
          </li>
        ) : (
          <li
            key={condicion.nombre}
            className={`${CHIP} bg-surface-2 text-ink-2`}
          >
            {condicion.nombre}
          </li>
        )
      })}
    </ul>
  )
}

/** The finished comparison: net bars, equity curve, four metric tiles and the conditions of the test. */
export default function ResultadoComparacion({
  informe,
  ocupado,
  onVolverACorrer,
}: Props) {
  const [viendo, setViendo] = useState(false)
  const o = informe.oficial.metricas
  const v = informe.variante.metricas
  const [largoOficial, largoVariante] = barrasDeNeto(o.neto_usd, v.neto_usd)
  return (
    <>
      <div
        role="group"
        aria-label="Neto del backtest"
        className="grid gap-2.5 border-y border-solid border-line py-3"
      >
        <Barra
          quien="Oficial"
          color="bg-info"
          punto="bg-info"
          operaciones={o.operaciones}
          neto={o.neto_usd}
          largo={largoOficial}
        />
        <Barra
          quien="Variante"
          color="bg-warn"
          punto="bg-warn"
          operaciones={v.operaciones}
          neto={v.neto_usd}
          largo={largoVariante}
        />
      </div>
      <CurvaSaldo informe={informe} />
      <Tiles informe={informe} />
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-solid border-line pt-4">
        <Condiciones informe={informe} />
        <span className="flex gap-2">
          <button
            type="button"
            className={BOTON}
            onClick={() => setViendo(true)}
          >
            Ver operaciones
          </button>
          <button
            type="button"
            className={BOTON}
            disabled={ocupado}
            onClick={onVolverACorrer}
          >
            Volver a correr
          </button>
        </span>
      </div>
      {viendo && (
        <OperacionesModal informe={informe} onClose={() => setViendo(false)} />
      )}
    </>
  )
}
