import { useEffect, useRef, useState } from 'react'
import {
  PRODUCTO_VELAS,
  consultaDeRango,
  segundosDe,
  type IntervaloVelas,
  type RangoMs,
  type Vela,
} from '../domain/estrategias-velas.ts'
import type { EstrategiasApi } from '../infrastructure/estrategias-api.ts'

type Estado = {
  velas: Vela[]
  cargando: boolean
  error: string | null
}

const CARGANDO: Estado = { velas: [], cargando: true, error: null }
const NADA: Estado = { velas: [], cargando: false, error: null }

const mensaje = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Candles of one stretch (`rango`) of the tested window `ventana = [desdeMs, hastaMs)` at one interval, in a single request.
 * Nothing outside the window is ever kept, even if a server answered with it; a change of interval, window or stretch starts
 * over, reads as «loading» meanwhile, and the answer of the old one is dropped. `rango: null` asks for nothing.
 */
export function useVelas(
  api: EstrategiasApi,
  ventana: RangoMs,
  intervalo: IntervaloVelas,
  rango: RangoMs | null,
) {
  const { desdeMs, hastaMs } = ventana
  const clave = rango
    ? `${intervalo}|${desdeMs}|${hastaMs}|${rango.desdeMs}|${rango.hastaMs}`
    : null
  const [guardado, setGuardado] = useState<Estado & { clave: string | null }>({
    ...CARGANDO,
    clave,
  })
  const vuelta = useRef(0)
  const rangoDesde = rango?.desdeMs
  const rangoHasta = rango?.hastaMs

  useEffect(() => {
    vuelta.current += 1
    if (clave === null || rangoDesde === undefined || rangoHasta === undefined)
      return
    const mia = vuelta.current
    const { antesMs, limite } = consultaDeRango(
      { desdeMs: rangoDesde, hastaMs: rangoHasta },
      { desdeMs, hastaMs },
      segundosDe(intervalo) * 1000,
    )
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
          for (const vela of respuesta.velas)
            if (vela.t >= desdeMs && vela.t < hastaMs)
              porInstante.set(vela.t, vela)
          setGuardado({
            clave,
            velas: [...porInstante.values()].sort((a, b) => a.t - b.t),
            cargando: false,
            error: null,
          })
        },
        (error: unknown) => {
          if (mia !== vuelta.current) return
          setGuardado({
            clave,
            velas: [],
            cargando: false,
            error: mensaje(error),
          })
        },
      )
    return () => {
      vuelta.current += 1
    }
  }, [api, intervalo, desdeMs, hastaMs, clave, rangoDesde, rangoHasta])

  // What was kept for another interval, window or stretch is not this one's.
  if (clave === null) return NADA
  return guardado.clave === clave ? guardado : CARGANDO
}
