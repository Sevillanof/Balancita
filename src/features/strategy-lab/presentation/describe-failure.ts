import { StrategyApiError } from '../infrastructure/strategy-api.ts'

/** A registry error in words the owner understands. */
export function describeFailure(failure: unknown): string {
  if (failure instanceof StrategyApiError) {
    if (failure.code === 'duplicate_spec')
      return 'Ya existe una estrategia con exactamente las mismas reglas y parámetros. Cambiá alguno para que sea otra.'
    if (failure.code === 'invalid_spec')
      return `La estrategia no es válida: ${failure.message}`
    return failure.message
  }
  return failure instanceof Error ? failure.message : String(failure)
}
