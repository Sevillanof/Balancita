/**
 * Client of the Terminal laboratory (`futures_estrategias_api.py`): variants of the Terminal config.
 * In dev Vite proxies `/api-strategies` to the registry process on 127.0.0.1:8790.
 */
export const ESTRATEGIAS_API_BASE = '/api-strategies'

export type PerillaTipo = 'entero' | 'decimal' | 'opcion'

/** One knob the server lets a strategy change (the only ones the form may offer). */
export type Perilla = {
  clave: string
  tipo: PerillaTipo
  valor_actual: number | string | null
  admite_null: boolean
  minimo?: number
  maximo?: number
  minimo_exclusivo?: boolean
  paso?: number | null
  opciones?: string[]
}

export type Cambios = { [key: string]: number | string | null | Cambios }

export type EstrategiaFila = {
  id: string
  nombre: string
  descripcion: string
  cambios: Cambios | null
  base_config_hash: string | null
  overlay_sha256: string | null
  /** Why the file cannot be used (unreadable, stale base, forbidden knob); `null` when it is fine. */
  error: string | null
}

export type Listado = {
  snapshot: { config_hash: string; origen?: Record<string, unknown> | null }
  ventana_honesta: { desde: string; hasta: string }
  perillas: Perilla[]
  estrategias: EstrategiaFila[]
}

export type Metricas = {
  operaciones: number
  neto_usd: number
  neto_bp_cuenta: number
  neto_bp_por_operacion: number | null
  acierto: number | null
  max_drawdown_usd: number
  max_drawdown_bp: number
  horas_promedio: number | null
  por_motivo: Record<string, number>
}

export type Diferencia = {
  [
    K in
      | 'operaciones'
      | 'neto_usd'
      | 'neto_bp_cuenta'
      | 'neto_bp_por_operacion'
      | 'acierto'
      | 'max_drawdown_usd'
      | 'max_drawdown_bp'
      | 'horas_promedio'
  ]: number | null
}

/** One closed trade of a run (`futures_estrategias_backtest._operaciones`). */
export type Operacion = {
  entrada_ms: number
  salida_ms: number
  lado: 'LONG' | 'SHORT'
  neto_usd: number
  neto_bp: number
  motivo: string
}

export type Corrida = {
  config_hash: string
  metricas: Metricas
  operaciones: Operacion[]
  funding_completo?: boolean
}

export type Informe = {
  estrategia: {
    id: string
    nombre: string
    descripcion: string
    overlay_sha256: string
    cambios: Cambios
  }
  snapshot: { config_hash: string }
  ventana: {
    desde: string
    hasta: string
    desde_efectivo: string
    /** Milliseconds of the same instants; the equity curve uses them as its x axis. */
    desde_ms?: number
    hasta_ms?: number
    desde_efectivo_ms?: number
    dias: number
    reserva: { incluida: boolean; desde: string; aviso?: string }
  }
  datos: {
    fuente: string
    funding_modelo?: string | null
    funding_archivo?: string | null
  }
  limites: string[]
  oficial: Corrida
  variante: Corrida
  diferencia: Diferencia
}

export type TrabajoEstado = 'corriendo' | 'listo' | 'error'

export type Trabajo = {
  job_id: string
  estrategia_id: string
  estado: TrabajoEstado
  desde: string
  hasta: string
  iniciado_ms: number
  terminado_ms: number | null
  informe: Informe | null
  error: string | null
}

export type NuevaEstrategia = {
  nombre: string
  descripcion: string
  cambios: Cambios
  id?: string
}

export type Ventana = { desde?: string; hasta?: string }

export class EstrategiasApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code = 'error') {
    super(message)
    this.name = 'EstrategiasApiError'
    this.status = status
    this.code = code
  }
}

export interface EstrategiasApi {
  listar(): Promise<Listado>
  crear(cuerpo: NuevaEstrategia): Promise<EstrategiaFila>
  /** Starts a comparison against the official config; never accepts the reserve. */
  comparar(id: string, ventana?: Ventana): Promise<Trabajo>
  trabajo(id: string, jobId: string): Promise<Trabajo>
  /** The latest comparison of that strategy since the server started, or `null`. */
  ultimo(id: string): Promise<Trabajo | null>
}

export function httpEstrategiasApi(
  base = ESTRATEGIAS_API_BASE,
  fetcher: typeof fetch = (...args) => fetch(...args),
): EstrategiasApi {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const payload: unknown = (() => {
      try {
        return text ? JSON.parse(text) : null
      } catch {
        return null
      }
    })()
    if (!response.ok) {
      const failure = (payload ?? {}) as { error?: string; detail?: string }
      throw new EstrategiasApiError(
        failure.detail ?? `El servidor respondió ${response.status}.`,
        response.status,
        failure.error,
      )
    }
    if (payload === null)
      throw new EstrategiasApiError(
        'Respuesta vacía del servidor.',
        response.status,
      )
    return payload as T
  }
  const id = (value: string) => encodeURIComponent(value)
  return {
    listar: () => request<Listado>('/estrategias'),
    crear: (cuerpo) => request<EstrategiaFila>('/estrategias', cuerpo),
    comparar: (estrategia, ventana = {}) =>
      request<Trabajo>(`/estrategias/${id(estrategia)}/comparar`, ventana),
    trabajo: (estrategia, jobId) =>
      request<Trabajo>(`/estrategias/${id(estrategia)}/comparar/${id(jobId)}`),
    ultimo: async (estrategia) => {
      try {
        return await request<Trabajo>(`/estrategias/${id(estrategia)}/comparar`)
      } catch (error) {
        if (error instanceof EstrategiasApiError && error.status === 404)
          return null
        throw error
      }
    },
  }
}

/** Probes the registry process before the page shows anything. */
export async function connectEstrategiasApi(
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<EstrategiasApi> {
  const response = await fetcher(`${ESTRATEGIAS_API_BASE}/health`)
  if (!response.ok)
    throw new EstrategiasApiError(
      `El registro de estrategias no responde (HTTP ${response.status}).`,
      response.status,
    )
  return httpEstrategiasApi(ESTRATEGIAS_API_BASE, fetcher)
}
