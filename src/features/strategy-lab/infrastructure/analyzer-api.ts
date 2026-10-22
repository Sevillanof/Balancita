import { STRATEGIES_API_BASE } from './strategy-api.ts'

/**
 * «Analizador de señales» (`GET /analyzer/events`, esquema
 * `balancita.analyzer-events.v1`). Solo lee: datos de práctica, ninguna orden.
 * Los retornos están en puntos básicos (pb): 1 pb = 0,01 % del importe operado.
 */
export type AnalyzerHorizonStats = {
  /** Retorno de comprar (largo) al abrir y cerrar al final del horizonte, sin signo de dirección. */
  r: number
  /** Máximo alcanzado sobre la entrada (>= 0). */
  up: number
  /** Mínimo bajo la entrada (<= 0). */
  dn: number
  /** Funding que PAGA un largo durante la tenencia (el corto recibe lo opuesto). */
  f: number
}

export type AnalyzerEvent = {
  /** Entrada, en milisegundos. */
  t: number
  /** Signo del movimiento que disparó el evento. */
  s: 1 | -1
  /** Por horizonte (clave: minutos como texto). */
  h: Record<string, AnalyzerHorizonStats>
}

export type AnalyzerCell = {
  id: string
  kind: 'move' | 'leader'
  product: string
  /** Minutos de la ventana del movimiento. */
  window: number
  /** `follow` = seguir el movimiento; `fade` = ir en contra. */
  direction: 'follow' | 'fade'
  horizon: number
  events: number
  events_exported: number
  gross_bp: number
  excess_bp: number
  ic90_low_bp: number | null
  p_holm: number
}

export type AnalyzerEvents = {
  schema: string
  family: string
  generated_at: string
  window: { from: string; to: string }
  horizons: number[]
  funding_complete?: boolean
  /** Coste de ida y vuelta por producto, en pb sobre el nocional (comisiones y deslizamiento incluidos). */
  round_trip_cost_bp: Record<string, number>
  cells: AnalyzerCell[]
  /** Clave: `<producto>|<tipo>|<ventana>`. */
  events: Record<string, AnalyzerEvent[]>
}

export type AnalyzerResponse =
  | { available: true; data: AnalyzerEvents }
  | { available: false; reason: string; command: string }

export type AnalyzerApi = {
  events: () => Promise<AnalyzerResponse>
}

export const analyzerApi: AnalyzerApi = {
  async events() {
    const response = await fetch(`${STRATEGIES_API_BASE}/analyzer/events`)
    if (!response.ok)
      throw new Error(`El registro respondió ${response.status}.`)
    return (await response.json()) as AnalyzerResponse
  },
}
