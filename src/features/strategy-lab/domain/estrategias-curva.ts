const redondeo = (valor: number) => Math.round(valor * 10) / 10

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
