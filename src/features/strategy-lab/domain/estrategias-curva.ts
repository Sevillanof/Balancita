export type PuntoCurva = { t: number; y: number }
export type Dominio = { tMin: number; tMax: number; yMin: number; yMax: number }

/**
 * Accumulated net (US$) of a run: a step line that starts at zero when the window starts, moves when
 * each trade closes and stays flat until the window ends. Trades are taken in exit order.
 */
export function curvaSaldo(
  operaciones: ReadonlyArray<{ salida_ms: number; neto_usd: number }>,
  desdeMs: number,
  hastaMs: number,
): PuntoCurva[] {
  const puntos: PuntoCurva[] = [{ t: desdeMs, y: 0 }]
  let saldo = 0
  for (const operacion of [...operaciones].sort(
    (a, b) => a.salida_ms - b.salida_ms,
  )) {
    puntos.push({ t: operacion.salida_ms, y: saldo })
    saldo += operacion.neto_usd
    puntos.push({ t: operacion.salida_ms, y: saldo })
  }
  puntos.push({ t: Math.max(hastaMs, desdeMs), y: saldo })
  return puntos
}

/** One shared box for several curves; zero is always inside and there is 8 % of air above and below. */
export function dominioDeCurvas(curvas: PuntoCurva[][]): Dominio {
  const puntos = curvas.flat()
  const ts = puntos.map((p) => p.t)
  const ys = puntos.map((p) => p.y)
  const yMin = Math.min(0, ...ys)
  const yMax = Math.max(0, ...ys)
  const aire = (yMax - yMin || 1) * 0.08
  return {
    tMin: Math.min(...ts),
    tMax: Math.max(...ts),
    yMin: yMin < 0 ? yMin - aire : 0,
    yMax: yMax + aire,
  }
}

/** Where an instant and a value fall in a `ancho × alto` box (y grows downwards). */
export function posicion(
  t: number,
  y: number,
  dominio: Dominio,
  ancho: number,
  alto: number,
): { x: number; y: number } {
  const tramo = dominio.tMax - dominio.tMin || 1
  const altura = dominio.yMax - dominio.yMin || 1
  return {
    x: ((t - dominio.tMin) / tramo) * ancho,
    y: alto - ((y - dominio.yMin) / altura) * alto,
  }
}

const redondeo = (valor: number) => Math.round(valor * 10) / 10

/** `points` of an SVG polyline. */
export function puntosSvg(
  curva: PuntoCurva[],
  dominio: Dominio,
  ancho: number,
  alto: number,
): string {
  return curva
    .map((punto) => {
      const { x, y } = posicion(punto.t, punto.y, dominio, ancho, alto)
      return `${redondeo(x)},${redondeo(y)}`
    })
    .join(' ')
}

/** Length of each net bar as a percentage of the track: by size, the larger one fills it. */
export function barrasDeNeto(
  oficial: number,
  variante: number,
): [number, number] {
  const mayor = Math.max(Math.abs(oficial), Math.abs(variante))
  if (mayor === 0) return [0, 0]
  const largo = (valor: number) => redondeo((Math.abs(valor) / mayor) * 100)
  return [largo(oficial), largo(variante)]
}
