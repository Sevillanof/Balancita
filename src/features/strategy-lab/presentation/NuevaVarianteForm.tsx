import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  agruparPerillas,
  cambiosDeEntradas,
  entradaInicial,
  etiquetaOpcion,
  etiquetaPerilla,
  resumenCambios,
  valorTexto,
} from '../domain/estrategias-format.ts'
import type {
  EstrategiaFila,
  EstrategiasApi,
  Perilla,
} from '../infrastructure/estrategias-api.ts'
import {
  AVISO,
  BOTON,
  BOTON_PRIMARIO,
  CAMPO,
  EYEBROW,
  PANEL,
} from './estrategias-styles.ts'

type Props = {
  api: EstrategiasApi
  /** The knobs the server allows: the only ones the form offers. */
  perillas: Perilla[]
  onClose: () => void
  onCreated: (fila: EstrategiaFila) => void
}

const mensaje = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * «Nueva variante»: a name and the allowed knobs, each showing its value today. Only what differs from today
 * is sent, and the description is the change itself so a variant always says what it tests.
 */
export default function NuevaVarianteForm({
  api,
  perillas,
  onClose,
  onCreated,
}: Props) {
  const [nombre, setNombre] = useState('')
  const [entradas, setEntradas] = useState<Record<string, string>>(() =>
    Object.fromEntries(perillas.map((p) => [p.clave, entradaInicial(p)])),
  )
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const primero = useRef<HTMLInputElement>(null)
  useEffect(() => primero.current?.focus(), [])

  const cambiar = (clave: string, valor: string) => {
    setEntradas((actual) => ({ ...actual, [clave]: valor }))
    setError(null)
  }

  const crear = async (event: FormEvent) => {
    event.preventDefault()
    const { cambios, error: invalido } = cambiosDeEntradas(perillas, entradas)
    if (invalido) return setError(invalido)
    if (Object.keys(cambios).length === 0)
      return setError('Cambiá al menos una perilla: ninguna difiere de hoy.')
    setOcupado(true)
    setError(null)
    try {
      onCreated(
        await api.crear({
          nombre: nombre.trim(),
          descripcion: resumenCambios(cambios, perillas),
          cambios,
        }),
      )
    } catch (falla) {
      setError(mensaje(falla))
      setOcupado(false)
    }
  }

  return (
    <form
      aria-labelledby="nueva-variante-titulo"
      onSubmit={(event) => void crear(event)}
      className={`${PANEL} flex min-w-0 flex-none flex-col gap-4 p-5 shadow-menu from-1000:min-h-0 from-1000:flex-1`}
    >
      <div className="flex items-center justify-between">
        <h2
          id="nueva-variante-titulo"
          className="m-0 text-title font-semibold tracking-title"
        >
          Nueva variante
        </h2>
        <button
          type="button"
          aria-label="Cerrar"
          className={`${BOTON} border-transparent! bg-transparent! text-ink-2`}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto">
        <label className="grid gap-1 text-note" htmlFor="variante-nombre">
          Nombre
          <input
            id="variante-nombre"
            ref={primero}
            value={nombre}
            maxLength={80}
            autoComplete="off"
            className={`${CAMPO} px-2.5!`}
            onChange={(event) => {
              setNombre(event.target.value)
              setError(null)
            }}
          />
        </label>
        {agruparPerillas(perillas).map(({ grupo, perillas: delGrupo }) => (
          <fieldset key={grupo} className="m-0 grid min-w-0 gap-2 border-0 p-0">
            <legend className={`${EYEBROW} mb-2 p-0`}>{grupo}</legend>
            {delGrupo.map((perilla) => {
              const id = `perilla-${perilla.clave}`
              const cambio = entradas[perilla.clave] !== entradaInicial(perilla)
              return (
                <div
                  key={perilla.clave}
                  className="flex items-center gap-2 text-note"
                >
                  <label htmlFor={id} className="min-w-0 flex-1">
                    {etiquetaPerilla(perilla.clave)}
                  </label>
                  {perilla.tipo === 'opcion' ? (
                    <select
                      id={id}
                      value={entradas[perilla.clave]}
                      aria-describedby={`${id}-hoy`}
                      className={`${CAMPO} w-28 ${cambio ? 'border-info!' : ''}`}
                      onChange={(event) =>
                        cambiar(perilla.clave, event.target.value)
                      }
                    >
                      {perilla.opciones?.map((opcion) => (
                        <option key={opcion} value={opcion}>
                          {etiquetaOpcion(opcion)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={id}
                      inputMode="decimal"
                      autoComplete="off"
                      value={entradas[perilla.clave]}
                      placeholder={perilla.admite_null ? 'sin stop' : undefined}
                      aria-describedby={`${id}-hoy`}
                      className={`${CAMPO} w-28 text-right font-mono ${cambio ? 'border-info!' : ''}`}
                      onChange={(event) =>
                        cambiar(perilla.clave, event.target.value)
                      }
                    />
                  )}
                  <span
                    id={`${id}-hoy`}
                    className="w-28 text-right font-mono text-hint text-ink-2"
                  >
                    hoy {valorTexto(perilla.clave, perilla.valor_actual)}
                  </span>
                </div>
              )
            })}
          </fieldset>
        ))}
        <p className="m-0 text-hint text-ink-2">
          Solo se ofrecen perillas permitidas; maestro y portero no se tocan.
          Una variante no se edita después: para otra idea, otra variante.
        </p>
      </div>
      {error && (
        <p role="alert" className={AVISO}>
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={BOTON} onClick={onClose}>
          Cancelar
        </button>
        <button
          type="submit"
          className={BOTON_PRIMARIO}
          disabled={ocupado || nombre.trim() === ''}
        >
          Crear y probar
        </button>
      </div>
    </form>
  )
}
