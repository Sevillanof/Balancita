import { useCallback, useEffect, useState } from 'react'
import { DataState } from '../../../shared/mission-control/index.ts'
import type {
  EstrategiasApi,
  Informe,
  Listado,
} from '../infrastructure/estrategias-api.ts'
import { BOTON_PRIMARIO, EYEBROW, PANEL } from './estrategias-styles.ts'
import NuevaVarianteForm from './NuevaVarianteForm.tsx'
import TerminalActivaCard from './TerminalActivaCard.tsx'
import { useComparaciones } from './use-comparaciones.ts'
import VarianteCard from './VarianteCard.tsx'
import VarianteDetalle from './VarianteDetalle.tsx'

type Props = {
  api: EstrategiasApi | null
  connectError: string | null
  pollMs?: number
}

const mensaje = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Estrategias: the laboratory of the Terminal. Left, the Terminal that trades and its variants (the official
 * config with a few knobs changed); right, the chosen variant against the official one, or the form for a new one.
 */
export default function EstrategiasPage({ api, connectError, pollMs }: Props) {
  if (connectError)
    return (
      <DataState
        kind="error"
        title="No se pudo leer las estrategias"
        detail={`${connectError} No se muestran datos de ejemplo.`}
      />
    )
  if (!api)
    return (
      <DataState
        kind="loading"
        title="Conectando con el registro de estrategias…"
      />
    )
  return <Laboratorio api={api} pollMs={pollMs} />
}

function Laboratorio({
  api,
  pollMs,
}: {
  api: EstrategiasApi
  pollMs?: number
}) {
  const [listado, setListado] = useState<Listado | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)
  const [elegida, setElegida] = useState<string | null>(null)
  const [creando, setCreando] = useState(false)
  const [aviso, setAviso] = useState<{ id: string; texto: string } | null>(null)
  const [recarga, setRecarga] = useState(0)
  const [ocupados, setOcupados] = useState<ReadonlySet<string>>(new Set())

  const ids = listado?.estrategias.map((fila) => fila.id) ?? []
  const { trabajos, correr } = useComparaciones(api, ids, pollMs)

  useEffect(() => {
    let activo = true
    api.listar().then(
      (datos) => {
        if (!activo) return
        setListado(datos)
        setFallo(null)
      },
      (error: unknown) => {
        if (activo) setFallo(mensaje(error))
      },
    )
    return () => {
      activo = false
    }
  }, [api, recarga])

  const iniciar = useCallback(
    async (id: string) => {
      setAviso(null)
      setOcupados((actual) => new Set(actual).add(id))
      try {
        await correr(id)
      } catch (error) {
        setAviso({ id, texto: mensaje(error) })
      } finally {
        setOcupados((actual) => {
          const resto = new Set(actual)
          resto.delete(id)
          return resto
        })
      }
    },
    [correr],
  )

  if (fallo)
    return (
      <DataState
        kind="error"
        title="No se pudo leer las estrategias"
        detail={fallo}
      />
    )
  if (!listado)
    return <DataState kind="loading" title="Cargando estrategias…" />

  const fila =
    listado.estrategias.find((e) => e.id === elegida) ??
    listado.estrategias[0] ??
    null
  const informe: Informe | null =
    [fila?.id, ...ids]
      .map((id) => (id ? trabajos[id] : null))
      .find((trabajo) => trabajo?.estado === 'listo' && trabajo.informe)
      ?.informe ?? null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto from-1000:flex-row from-1000:overflow-visible">
      <section
        aria-label="Variantes"
        className={`${PANEL} flex min-h-0 w-full shrink-0 flex-col gap-3 p-4 from-1000:w-95`}
      >
        <TerminalActivaCard snapshot={listado.snapshot} informe={informe} />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className={EYEBROW}>
            Variantes · {listado.estrategias.length}
          </span>
          <button
            type="button"
            className={BOTON_PRIMARIO}
            onClick={() => setCreando(true)}
          >
            + Nueva variante
          </button>
        </div>
        {listado.estrategias.length === 0 ? (
          <p className="m-0 text-note text-ink-2">Todavía no hay variantes.</p>
        ) : (
          <ul
            aria-label="Lista de variantes"
            className="m-0 flex min-h-0 flex-1 list-none flex-col gap-3 overflow-auto p-0"
          >
            {listado.estrategias.map((estrategia) => (
              <VarianteCard
                key={estrategia.id}
                fila={estrategia}
                perillas={listado.perillas}
                trabajo={trabajos[estrategia.id]}
                actual={!creando && estrategia.id === fila?.id}
                onElegir={() => {
                  setCreando(false)
                  setElegida(estrategia.id)
                }}
              />
            ))}
          </ul>
        )}
      </section>
      {creando ? (
        <NuevaVarianteForm
          api={api}
          perillas={listado.perillas}
          onClose={() => setCreando(false)}
          onCreated={(nueva) => {
            setRecarga((veces) => veces + 1)
            setElegida(nueva.id)
            setCreando(false)
            void iniciar(nueva.id)
          }}
        />
      ) : fila ? (
        <VarianteDetalle
          key={fila.id}
          api={api}
          fila={fila}
          perillas={listado.perillas}
          trabajo={trabajos[fila.id]}
          aviso={aviso?.id === fila.id ? aviso.texto : null}
          ocupado={ocupados.has(fila.id)}
          onCorrer={() => void iniciar(fila.id)}
        />
      ) : (
        <div className="min-w-0 flex-1">
          <DataState
            kind="empty"
            title="Sin variantes"
            detail="Creá una variante de la Terminal para compararla con la oficial."
          />
        </div>
      )}
    </div>
  )
}
