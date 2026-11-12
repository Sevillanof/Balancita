import { useEffect, useState } from 'react'
import {
  MAX_VELAS,
  PRODUCTO_VELAS,
  type IntervaloVelas,
  type RangoMs,
  type Vela,
} from '../domain/estrategias-velas.ts'
import type { EstrategiasApi } from '../infrastructure/estrategias-api.ts'

type Estado = {
  clave: string
  velas: Vela[]
  cargando: boolean
  error: string | null
  /** Candles loaded so far, for the «cargando» text. */
  cargadas: number
}

const mensaje = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Every candle of the tested window `[desdeMs, hastaMs)` at one interval, oldest first: the server answers the newest page
 * (`MAX_VELAS`) before a cursor, so older pages are asked for one after another until it says there are no more. Nothing
 * outside the window is kept (the server never sends the reserve either). A change of interval or window starts over and the
 * answer of the old one is dropped.
 */
export function useVelasVentana(
  api: EstrategiasApi,
  ventana: RangoMs,
  intervalo: IntervaloVelas,
) {
  const { desdeMs, hastaMs } = ventana
  const clave = `${intervalo}|${desdeMs}|${hastaMs}`
  const [estado, setEstado] = useState<Estado>({
    clave,
    velas: [],
    cargando: true,
    error: null,
    cargadas: 0,
  })

  useEffect(() => {
    let vigente = true
    const porInstante = new Map<number, Vela>()
    const ordenadas = () => [...porInstante.values()].sort((a, b) => a.t - b.t)
    const leer = async () => {
      let antesMs = hastaMs
      // The window cannot hold more than a few hundred thousand candles: the bound only stops a server that never ends.
      for (let pagina = 0; pagina < 200 && vigente; pagina += 1) {
        const respuesta = await api.velas({
          producto: PRODUCTO_VELAS,
          intervalo,
          desdeMs,
          hastaMs,
          antesMs,
          limite: MAX_VELAS,
        })
        if (!vigente) return
        for (const vela of respuesta.velas)
          if (vela.t >= desdeMs && vela.t < hastaMs)
            porInstante.set(vela.t, vela)
        const primera = respuesta.velas.reduce(
          (min, vela) => Math.min(min, vela.t),
          Infinity,
        )
        if (!respuesta.hay_mas || primera >= antesMs) break
        antesMs = primera
        setEstado({
          clave,
          velas: [],
          cargando: true,
          error: null,
          cargadas: porInstante.size,
        })
      }
      if (vigente)
        setEstado({
          clave,
          velas: ordenadas(),
          cargando: false,
          error: null,
          cargadas: porInstante.size,
        })
    }
    leer().catch((error: unknown) => {
      if (vigente)
        setEstado({
          clave,
          velas: [],
          cargando: false,
          error: mensaje(error),
          cargadas: 0,
        })
    })
    return () => {
      vigente = false
    }
  }, [api, intervalo, desdeMs, hastaMs, clave])

  // What was kept for another interval or window is not this one's.
  return estado.clave === clave
    ? estado
    : { ...estado, clave, velas: [], cargando: true, error: null, cargadas: 0 }
}
