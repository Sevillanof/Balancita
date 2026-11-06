import {
  segundosCorriendo,
  segundosTardados,
} from '../domain/estrategias-estado.ts'
import { segmentosCambios } from '../domain/estrategias-format.ts'
import type {
  EstrategiaFila,
  EstrategiasApi,
  Perilla,
  Trabajo,
} from '../infrastructure/estrategias-api.ts'
import { AVISO, BOTON, BOTON_PRIMARIO, PANEL } from './estrategias-styles.ts'
import ResultadoComparacion from './ResultadoComparacion.tsx'

type Props = {
  api: EstrategiasApi
  fila: EstrategiaFila
  perillas: Perilla[]
  /** `undefined` while the server is still asked. */
  trabajo: Trabajo | null | undefined
  /** A refusal of the last attempt to run it. */
  aviso: string | null
  ocupado: boolean
  onCorrer: () => void
}

const PROXIMAMENTE = 'Próximamente: todavía no se puede'

type Etapa = {
  nombre: string
  derecha: string
  /** 0–100 */
  avance: number
  barra: string
  nombreTono: string
  proximamente?: boolean
}

function etapaBacktest(trabajo: Trabajo | null | undefined): Etapa {
  const base = { nombre: 'Backtest' }
  if (trabajo?.estado === 'corriendo') {
    const segundos = segundosCorriendo(trabajo)
    return {
      ...base,
      derecha: `corriendo${segundos === null ? '' : ` · ${segundos} s`}`,
      avance: 50,
      barra: 'bg-info',
      nombreTono: 'text-info',
    }
  }
  if (trabajo?.estado === 'error')
    return {
      ...base,
      derecha: 'falló',
      avance: 100,
      barra: 'bg-short',
      nombreTono: 'text-short',
    }
  if (trabajo?.estado === 'listo') {
    const segundos = segundosTardados(trabajo)
    return {
      ...base,
      derecha: `listo${segundos === null ? '' : ` · ${segundos} s`}`,
      avance: 100,
      barra: 'bg-long',
      nombreTono: 'text-long',
    }
  }
  return {
    ...base,
    derecha: trabajo === undefined ? 'cargando…' : 'sin correr',
    avance: 0,
    barra: 'bg-long',
    nombreTono: 'text-ink-2',
  }
}

/** Backtest → Sombra → Promover. Only the first stage exists today; the others say so. */
function Etapas({ trabajo }: { trabajo: Trabajo | null | undefined }) {
  const etapas: Etapa[] = [
    etapaBacktest(trabajo),
    {
      nombre: 'Sombra',
      derecha: '0 / 100 operaciones',
      avance: 0,
      barra: 'bg-long',
      nombreTono: 'text-ink-2',
      proximamente: true,
    },
    {
      nombre: 'Promover',
      derecha: 'a la Terminal',
      avance: 0,
      barra: 'bg-long',
      nombreTono: 'text-ink-2',
      proximamente: true,
    },
  ]
  return (
    <ul
      aria-label="Etapas de la variante"
      className="m-0 grid list-none grid-cols-3 gap-5 p-0"
    >
      {etapas.map((etapa) => (
        <li
          key={etapa.nombre}
          aria-disabled={etapa.proximamente ? 'true' : undefined}
          title={etapa.proximamente ? PROXIMAMENTE : undefined}
          className="grid min-w-0 gap-2"
        >
          <span className="h-1.5 rounded-full bg-line">
            <span
              className={`block h-full rounded-full ${etapa.barra}`}
              style={{ width: `${etapa.avance}%` }}
            />
          </span>
          <span className="flex justify-between gap-2 text-hint text-ink-2">
            <b className={`font-semibold ${etapa.nombreTono}`}>
              {etapa.nombre}
              {etapa.proximamente && (
                <span className="sr-only"> (próximamente)</span>
              )}
            </b>
            <span className="font-mono">{etapa.derecha}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function Vacio({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 content-center justify-items-center gap-3 text-center text-note text-ink-2">
      {children}
    </div>
  )
}

/**
 * The chosen variant against the official Terminal. No title: the selected card on the left says which one.
 * Without a result it shows why (never run, running, failed or unusable) instead of empty charts.
 */
export default function VarianteDetalle({
  api,
  fila,
  perillas,
  trabajo,
  aviso,
  ocupado,
  onCorrer,
}: Props) {
  const cambios = segmentosCambios(fila.cambios, perillas)
  const informe = trabajo?.estado === 'listo' ? trabajo.informe : null
  return (
    <section
      aria-label={`Detalle de «${fila.nombre}»`}
      className={`${PANEL} flex min-w-0 flex-none flex-col gap-5 p-6 shadow-menu from-1000:min-h-0 from-1000:flex-1`}
    >
      <Etapas trabajo={fila.error ? null : trabajo} />
      {aviso && (
        <p role="alert" className={AVISO}>
          {aviso}
        </p>
      )}
      {fila.error ? (
        <Vacio>
          <p role="alert" className={`${AVISO} max-w-xl text-left`}>
            Esta variante no se puede probar: {fila.error}
          </p>
        </Vacio>
      ) : informe ? (
        <ResultadoComparacion
          api={api}
          informe={informe}
          ocupado={ocupado}
          onVolverACorrer={onCorrer}
        />
      ) : trabajo?.estado === 'corriendo' ? (
        <Vacio>
          <p className="m-0 text-body text-ink">
            Probando contra la Terminal activa…
          </p>
          <p className="m-0 max-w-md">
            Misma ventana y mismos datos para las dos. Tarda unos segundos por
            configuración.
          </p>
        </Vacio>
      ) : trabajo?.estado === 'error' ? (
        <Vacio>
          <p role="alert" className={`${AVISO} max-w-xl text-left`}>
            {trabajo.error ?? 'La comparación falló sin dar un motivo.'}
          </p>
          <button
            type="button"
            className={BOTON}
            disabled={ocupado}
            onClick={onCorrer}
          >
            Volver a correr
          </button>
        </Vacio>
      ) : trabajo === undefined ? (
        <Vacio>
          <p className="m-0">Cargando la última prueba…</p>
        </Vacio>
      ) : (
        <Vacio>
          <p className="m-0 text-body text-ink">Todavía no se probó</p>
          {fila.descripcion && (
            <p className="m-0 max-w-md">{fila.descripcion}</p>
          )}
          <p className="m-0 max-w-md">
            {cambios.map((cambio, i) => (
              <span key={cambio.clave}>
                {i > 0 && ' · '}
                {cambio.etiqueta} {cambio.hoy} →{' '}
                <b className="font-semibold text-ink">{cambio.nuevo}</b>
              </span>
            ))}
          </p>
          <button
            type="button"
            className={BOTON_PRIMARIO}
            disabled={ocupado}
            onClick={onCorrer}
          >
            Correr backtest
          </button>
        </Vacio>
      )}
    </section>
  )
}
