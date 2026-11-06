import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EstrategiasApiError,
  type EstrategiasApi,
  type Trabajo,
} from '../infrastructure/estrategias-api.ts'

/** Latest comparison per strategy id: absent = still asking, `null` = it has none. */
export type Comparaciones = Record<string, Trabajo | null>

const OLVIDADO =
  'El servidor ya no recuerda esta comparación (se reinició). Volvé a correrla.'

/**
 * Keeps the latest comparison of each strategy and follows the running ones until they finish.
 * The server keeps jobs in memory only, so a 404 while following one means it was lost.
 */
export function useComparaciones(
  api: EstrategiasApi,
  ids: string[],
  pollMs = 2000,
) {
  const [trabajos, setTrabajos] = useState<Comparaciones>({})
  const vivo = useRef(true)
  const pedidos = useRef(new Set<string>())

  useEffect(() => {
    vivo.current = true
    return () => {
      vivo.current = false
    }
  }, [])

  const clave = ids.join('\n')
  useEffect(() => {
    for (const id of clave === '' ? [] : clave.split('\n')) {
      if (pedidos.current.has(id)) continue
      pedidos.current.add(id)
      const guardar = (trabajo: Trabajo | null) => {
        // A run started meanwhile is newer than what the server remembered.
        if (vivo.current)
          setTrabajos((actual) =>
            id in actual ? actual : { ...actual, [id]: trabajo },
          )
      }
      api.ultimo(id).then(guardar, () => guardar(null))
    }
  }, [api, clave])

  const corriendo = Object.values(trabajos)
    .filter((trabajo) => trabajo?.estado === 'corriendo')
    .map((trabajo) => `${trabajo!.estrategia_id}\t${trabajo!.job_id}`)
    .join('\n')
  useEffect(() => {
    if (corriendo === '') return
    const reemplazar = (
      id: string,
      jobId: string,
      cambio: (actual: Trabajo) => Trabajo,
    ) => {
      if (!vivo.current) return
      setTrabajos((actual) => {
        const trabajo = actual[id]
        return trabajo?.job_id === jobId
          ? { ...actual, [id]: cambio(trabajo) }
          : actual
      })
    }
    const timer = setInterval(() => {
      for (const par of corriendo.split('\n')) {
        const [id, jobId] = par.split('\t')
        api.trabajo(id, jobId).then(
          (nuevo) => reemplazar(id, jobId, () => nuevo),
          (error: unknown) => {
            if (error instanceof EstrategiasApiError && error.status === 404)
              reemplazar(id, jobId, (anterior) => ({
                ...anterior,
                estado: 'error',
                terminado_ms: Date.now(),
                error: OLVIDADO,
              }))
          },
        )
      }
    }, pollMs)
    return () => clearInterval(timer)
  }, [api, corriendo, pollMs])

  /** Starts a comparison against the official Terminal; the server's refusal reaches the caller. */
  const correr = useCallback(
    async (id: string) => {
      const trabajo = await api.comparar(id)
      if (vivo.current) setTrabajos((actual) => ({ ...actual, [id]: trabajo }))
    },
    [api],
  )

  return { trabajos, correr }
}
