import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PRODUCTO_VELAS,
  velasIniciales,
  velasPorPagina,
  type IntervaloVelas,
  type Vela,
} from '../domain/estrategias-velas.ts'
import type { EstrategiasApi } from '../infrastructure/estrategias-api.ts'

type Estado = {
  velas: Vela[]
  /** There are older candles inside the tested window than the oldest one held. */
  hayMas: boolean
  cargando: boolean
  error: string | null
}

const VACIO: Estado = { velas: [], hayMas: false, cargando: true, error: null }

const mensaje = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Candles of the tested window `[desdeMs, hastaMs)` at one interval: the newest ten days first, older pages on demand.
 * Nothing outside the window is ever kept, even if a server answered with it; a change of interval or window starts over
 * and the answer of the old one is dropped.
 */
export function useVelas(
  api: EstrategiasApi,
  ventana: { desdeMs: number; hastaMs: number },
  intervalo: IntervaloVelas,
) {
  const { desdeMs, hastaMs } = ventana
  const clave = `${intervalo}|${desdeMs}|${hastaMs}`
  const [guardado, setGuardado] = useState<Estado & { clave: string }>({
    ...VACIO,
    clave,
  })
  // What was kept for another interval or window is not this one's: it reads as «loading» until its own answer arrives.
  const estado: Estado =
    guardado.clave === clave ? guardado : { ...VACIO, clave }
  const actual = useRef(estado)
  const vuelta = useRef(0)

  useEffect(() => {
    actual.current = estado
  })

  const pedir = useCallback(
    (antesMs: number, limite: number, previas: Vela[]) => {
      const mia = vuelta.current
      void api
        .velas({
          producto: PRODUCTO_VELAS,
          intervalo,
          desdeMs,
          hastaMs,
          antesMs,
          limite,
        })
        .then(
          (respuesta) => {
            if (mia !== vuelta.current) return
            const porInstante = new Map<number, Vela>()
            for (const vela of [...respuesta.velas, ...previas])
              if (vela.t >= desdeMs && vela.t < hastaMs)
                porInstante.set(vela.t, vela)
            const velas = [...porInstante.values()].sort((a, b) => a.t - b.t)
            setGuardado({
              clave,
              velas,
              hayMas: respuesta.hay_mas && velas.length > 0,
              cargando: false,
              error: null,
            })
          },
          (error: unknown) => {
            if (mia !== vuelta.current) return
            setGuardado({
              clave,
              velas: previas,
              hayMas: false,
              cargando: false,
              error: mensaje(error),
            })
          },
        )
    },
    [api, intervalo, desdeMs, hastaMs, clave],
  )

  useEffect(() => {
    vuelta.current += 1
    pedir(hastaMs, velasIniciales(intervalo), [])
    return () => {
      vuelta.current += 1
    }
  }, [pedir, hastaMs, intervalo])

  const cargarAnteriores = useCallback(() => {
    const { velas, hayMas, cargando } = actual.current
    if (cargando || !hayMas || velas.length === 0) return
    actual.current = { ...actual.current, cargando: true }
    setGuardado({ ...actual.current, clave })
    pedir(velas[0]!.t, velasPorPagina(intervalo), velas)
  }, [pedir, clave, intervalo])

  return { ...estado, cargarAnteriores }
}
