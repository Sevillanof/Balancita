import { useLayoutEffect, useRef, useState } from 'react'
import type {
  DetalleOperacion,
  ParOperacion,
  Vela,
} from '../domain/estrategias-velas.ts'
import VelasUna from './VelasUna.tsx'
import VelasVarias from './VelasVarias.tsx'

export type ModoVelas = 'una' | 'varias'

type Props = {
  modo: ModoVelas
  velas: readonly Vela[]
  pares: readonly ParOperacion[]
  /** The chosen trade, an index of `pares`. */
  indice: number
  /** `null` until the candles of the chosen trade are here. */
  detalle: DetalleOperacion | null
  pasoMs: number
  onElegir: (indice: number) => void
}

/** What the SVG gets when the box cannot be measured (jsdom, or before the first layout). */
const TAMANO_INICIAL = { ancho: 720, alto: 340 }

/** The size of the box the SVG fills; it follows the box, so the chart always fits inside its panel. */
function useTamano() {
  const caja = useRef<HTMLDivElement>(null)
  const [tamano, setTamano] = useState(TAMANO_INICIAL)
  useLayoutEffect(() => {
    const nodo = caja.current
    if (!nodo) return
    const medir = () => {
      const { width, height } = nodo.getBoundingClientRect()
      if (width < 1 || height < 1) return
      const ancho = Math.round(width)
      const alto = Math.round(height)
      setTamano((antes) =>
        antes.ancho === ancho && antes.alto === alto ? antes : { ancho, alto },
      )
    }
    medir()
    if (typeof ResizeObserver === 'undefined') return
    const observador = new ResizeObserver(medir)
    observador.observe(nodo)
    return () => observador.disconnect()
  }, [])
  return { caja, ...tamano }
}

/**
 * ETH candles of the tested window with the trades of the official Terminal and the variant, drawn as SVG that fills its box:
 * «Una operación» zooms into the chosen trade with its three exits, «Varias» shows about five days with one bar per trade.
 */
export default function VelasChart({
  modo,
  velas,
  pares,
  indice,
  detalle,
  pasoMs,
  onElegir,
}: Props) {
  const { caja, ancho, alto } = useTamano()
  return (
    <div ref={caja} className="relative min-h-0 min-w-0 flex-1">
      {modo === 'una' && detalle && (
        <VelasUna
          velas={velas}
          detalle={detalle}
          pasoMs={pasoMs}
          ancho={ancho}
          alto={alto}
        />
      )}
      {modo === 'varias' && pares[indice] && (
        <VelasVarias
          velas={velas}
          pares={pares}
          indice={indice}
          pasoMs={pasoMs}
          ancho={ancho}
          alto={alto}
          onElegir={onElegir}
        />
      )}
    </div>
  )
}
