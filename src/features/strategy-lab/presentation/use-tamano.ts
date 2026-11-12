import { useLayoutEffect, useRef, useState } from 'react'

/** What the SVG gets when the box cannot be measured (jsdom, or before the first layout). */
const TAMANO_INICIAL = { ancho: 720, alto: 340 }

/** The size of the box an SVG fills; it follows the box, so the drawing always fits inside its panel. */
export function useTamano() {
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
