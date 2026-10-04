import {
  HISTORICAL_INTERVALS,
  HISTORICAL_STRATEGIES,
  type HistoricalRequest,
} from './types.ts'

export function validateHistoricalRequest(
  request: HistoricalRequest,
): string | null {
  if (!isDate(request.from) || !isDate(request.to) || request.from > request.to)
    return 'La fecha inicial debe ser anterior o igual a la final.'
  if (
    !Number.isFinite(Date.parse(`${request.from}T00:00:00.000Z`)) ||
    !Number.isFinite(Date.parse(`${request.to}T00:00:00.000Z`))
  )
    return 'Introduce fechas válidas en UTC.'
  if (!Number.isFinite(request.capital) || request.capital <= 0)
    return 'Introduce un capital inicial finito mayor que cero.'
  if (!HISTORICAL_INTERVALS.includes(request.interval))
    return 'El intervalo seleccionado no está disponible en esta demo.'
  if (!HISTORICAL_STRATEGIES.includes(request.strategy))
    return 'La etiqueta de estrategia seleccionada no está disponible en esta demo.'
  if (request.asset !== 'BTC/EUR')
    return 'Esta simulación de ejemplo solo ofrece BTC/EUR.'
  return null
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  )
}
