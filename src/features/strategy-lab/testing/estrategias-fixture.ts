import { vi, type Mocked } from 'vitest'
import type {
  ConsultaVelas,
  EstrategiaFila,
  EstrategiasApi,
  Informe,
  Listado,
  Metricas,
  Operacion,
  Perilla,
  RespuestaVelas,
  Trabajo,
} from '../infrastructure/estrategias-api.ts'

export const HASH =
  '37f572a841d35a7b7a8d01569378c508c6bcd9c8a4a6a2adb96e5d1097eade07'

export const PERILLAS: Perilla[] = [
  {
    clave: 'guardrails.max_hold_min',
    tipo: 'entero',
    valor_actual: 2160,
    admite_null: false,
    minimo: 60,
    maximo: 10080,
    minimo_exclusivo: false,
    paso: null,
  },
  {
    clave: 'guardrails.exhaust_hold_min',
    tipo: 'entero',
    valor_actual: 1440,
    admite_null: false,
    minimo: 60,
    maximo: 10080,
    minimo_exclusivo: false,
    paso: null,
  },
  {
    clave: 'guardrails.stop_sigma_24h',
    tipo: 'decimal',
    valor_actual: null,
    admite_null: true,
    minimo: 0,
    maximo: 10,
    minimo_exclusivo: true,
    paso: null,
  },
  {
    clave: 'guardrails.cooldown_min',
    tipo: 'entero',
    valor_actual: 15,
    admite_null: false,
    minimo: 0,
    maximo: 1440,
    minimo_exclusivo: false,
    paso: null,
  },
  {
    clave: 'wake.flat_every_min',
    tipo: 'entero',
    valor_actual: 15,
    admite_null: false,
    minimo: 5,
    maximo: 1440,
    minimo_exclusivo: false,
    paso: 5,
  },
  {
    clave: 'rebotes.caida_pct',
    tipo: 'decimal',
    valor_actual: 5,
    admite_null: false,
    minimo: 0,
    maximo: 100,
    minimo_exclusivo: true,
    paso: null,
  },
]

/** What a server from before the sizing rules became fixed still lists: the form must not offer them. */
export const PERILLAS_DE_TAMANO: Perilla[] = [
  {
    clave: 'posiciones.max',
    tipo: 'entero',
    valor_actual: 3,
    admite_null: false,
    minimo: 1,
    maximo: 3,
    minimo_exclusivo: false,
    paso: null,
  },
  {
    clave: 'posiciones.fraccion',
    tipo: 'decimal',
    valor_actual: 0.33,
    admite_null: false,
    minimo: 0,
    maximo: 1,
    minimo_exclusivo: true,
    paso: null,
  },
  {
    clave: 'analista.modo',
    tipo: 'opcion',
    valor_actual: 'fuerte',
    admite_null: false,
    opciones: ['apagado', 'suave', 'fuerte'],
  },
]

export const EJEMPLO: EstrategiaFila = {
  id: 'ejemplo-salida-30h',
  nombre: 'Salida a 30 h',
  descripcion: 'La Terminal activa con el cierre obligatorio a 30 h.',
  cambios: { guardrails: { max_hold_min: 1800 } },
  base_config_hash: HASH,
  overlay_sha256: 'a'.repeat(64),
  error: null,
}

export const REBOTES: EstrategiaFila = {
  id: 'rebotes-6',
  nombre: 'Rebotes más exigentes',
  descripcion: 'Rebote solo con caídas de 6 %.',
  cambios: { rebotes: { caida_pct: 6 } },
  base_config_hash: HASH,
  overlay_sha256: 'b'.repeat(64),
  error: null,
}

export const ESPERA: EstrategiaFila = {
  id: 'sin-espera',
  nombre: 'Sin espera tras cerrar',
  descripcion: 'Vuelve a entrar en cuanto cierra.',
  cambios: { guardrails: { cooldown_min: 0 } },
  base_config_hash: HASH,
  overlay_sha256: 'c'.repeat(64),
  error: null,
}

/** A file written when sizing was still a knob: the server now refuses it naming the key. */
export const DE_TAMANO: EstrategiaFila = {
  id: 'dos-posiciones',
  nombre: 'Dos posiciones al 50 %',
  descripcion: 'Menos cupos, más grandes.',
  cambios: { posiciones: { max: 2, fraccion: 0.5 } },
  base_config_hash: HASH,
  overlay_sha256: 'f'.repeat(64),
  error:
    "Estrategia 'dos-posiciones': la clave 'posiciones.max' no se puede cambiar; solo hay perillas permitidas: guardrails.cooldown_min.",
}

export const VIEJA: EstrategiaFila = {
  id: 'vieja',
  nombre: 'Vieja',
  descripcion: 'Quedó sobre otra base.',
  cambios: { guardrails: { max_hold_min: 900 } },
  base_config_hash: '0'.repeat(64),
  overlay_sha256: 'd'.repeat(64),
  error:
    "Estrategia 'vieja': base_config_hash (000) no coincide con el hash del snapshot de la Terminal.",
}

export const listado = (
  estrategias: EstrategiaFila[] = [EJEMPLO],
): Listado => ({
  snapshot: {
    config_hash: HASH,
    origen: { version_id: 3, activada_utc: '2026-11-02T14:15:54.811Z' },
  },
  ventana_honesta: { desde: '2026-02-01', hasta: '2026-04-19' },
  perillas: PERILLAS,
  estrategias,
})

const metricas = (patch: Partial<Metricas>): Metricas => ({
  operaciones: 180,
  neto_usd: 97.7,
  neto_bp_cuenta: 977,
  neto_bp_por_operacion: 5.4,
  acierto: 0.54,
  max_drawdown_usd: 31.4,
  max_drawdown_bp: 314,
  horas_promedio: 21.4,
  horas_max: 36,
  nocional_promedio_usd: 335.2,
  por_motivo: { tiempo: 150, maestro_vuelta: 30 },
  ...patch,
})

const DIA = 86_400_000
export const DESDE_MS = Date.UTC(2026, 1, 3)
export const HASTA_MS = Date.UTC(2026, 3, 19)

/** Few closed trades are enough to draw a curve; the counts in `metricas` are the real window's. */
const op = (dia: number, horas: number, neto: number): Operacion => ({
  entrada_ms: DESDE_MS + dia * DIA,
  salida_ms: DESDE_MS + dia * DIA + horas * 3_600_000,
  lado: neto >= 0 ? 'LONG' : 'SHORT',
  neto_usd: neto,
  neto_bp: neto * 10,
  motivo: horas >= 30 ? 'tiempo' : 'maestro_vuelta',
})

export const INFORME: Informe = {
  estrategia: {
    id: EJEMPLO.id,
    nombre: EJEMPLO.nombre,
    descripcion: EJEMPLO.descripcion,
    overlay_sha256: 'a'.repeat(64),
    cambios: { guardrails: { max_hold_min: 1800 } },
  },
  snapshot: { config_hash: HASH },
  ventana: {
    desde: '2026-02-01',
    hasta: '2026-04-19',
    desde_efectivo: '2026-02-03',
    desde_ms: Date.UTC(2026, 1, 1),
    hasta_ms: HASTA_MS,
    desde_efectivo_ms: DESDE_MS,
    dias: 75,
    reserva: { incluida: false, desde: '2026-04-19' },
  },
  datos: { fuente: 'caché local de velas y funding /tmp/cache (sin red)' },
  limites: [
    'sin noticias (no se evalúan históricas: no hay evidencia limpia)',
    'sin libro de órdenes (costos del modelo, no fills reales)',
    'sin posicionamiento',
  ],
  oficial: {
    config_hash: HASH,
    metricas: metricas({}),
    operaciones: [
      op(1, 20, 30),
      op(10, 24, -10),
      op(30, 20, 50),
      op(60, 22, 27.7),
    ],
  },
  variante: {
    config_hash: 'e'.repeat(64),
    metricas: metricas({
      operaciones: 182,
      neto_usd: 53.63,
      neto_bp_cuenta: 536.3,
      neto_bp_por_operacion: 2.9,
      acierto: 0.52,
      max_drawdown_usd: 38.2,
      max_drawdown_bp: 382,
      horas_promedio: 18.9,
      horas_max: 30,
      nocional_promedio_usd: 321.6,
    }),
    operaciones: [
      op(1, 18, 20),
      op(10, 30, -15),
      op(30, 20, 30),
      op(60, 18, 18.63),
    ],
  },
  diferencia: {
    operaciones: 2,
    neto_usd: -44.07,
    neto_bp_cuenta: -440.7,
    neto_bp_por_operacion: -2.5,
    acierto: -0.02,
    max_drawdown_usd: 6.8,
    max_drawdown_bp: 68,
    horas_promedio: -2.5,
    horas_max: -6,
    nocional_promedio_usd: -13.6,
  },
}

export const trabajo = (patch: Partial<Trabajo> = {}): Trabajo => ({
  job_id: 'abc123',
  estrategia_id: EJEMPLO.id,
  estado: 'corriendo',
  desde: '2026-02-01',
  hasta: '2026-04-19',
  iniciado_ms: 1_000,
  terminado_ms: null,
  informe: null,
  error: null,
  ...patch,
})

/** A finished comparison that took 22 s. */
export const trabajoListo = (patch: Partial<Trabajo> = {}) =>
  trabajo({
    estado: 'listo',
    iniciado_ms: 1_000,
    terminado_ms: 23_000,
    informe: INFORME,
    ...patch,
  })

const PASO_VELAS: Record<ConsultaVelas['intervalo'], number> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

/** The server contract in one place: complete candles of `[desde, hasta)` before `antes`, the newest `limite` of them. */
export function velasFalsas(consulta: ConsultaVelas): RespuestaVelas {
  const paso = PASO_VELAS[consulta.intervalo]
  const inicio = Math.ceil(consulta.desdeMs / paso) * paso
  const corte =
    Math.floor(Math.min(consulta.antesMs, consulta.hastaMs) / paso) * paso
  const primera = Math.max(inicio, corte - consulta.limite * paso)
  const velas = []
  for (let t = primera; t < corte; t += paso) {
    const base = 2000 + 80 * Math.sin(t / (paso * 40))
    velas.push({
      t,
      o: base,
      h: base + 12,
      l: base - 12,
      c: base + 6 * Math.cos(t / paso),
      v: 10,
    })
  }
  return {
    producto: consulta.producto,
    intervalo: consulta.intervalo,
    desde_ms: inicio,
    hasta_ms: Math.floor(consulta.hastaMs / paso) * paso,
    velas,
    hay_mas: velas.length > 0 && primera > inicio,
  }
}

/** `jobs`: the latest comparison the server remembers per strategy id (missing = none). */
export function fakeApi(
  estrategias: EstrategiaFila[] = [EJEMPLO],
  jobs: Record<string, Trabajo> = {},
  patch: Partial<EstrategiasApi> = {},
) {
  const api = {
    listar: vi.fn(async () => listado(estrategias)),
    crear: vi.fn(async (): Promise<EstrategiaFila> => EJEMPLO),
    comparar: vi.fn(async (id: string) => trabajo({ estrategia_id: id })),
    trabajo: vi.fn(async (id: string) =>
      trabajoListo({ estrategia_id: id, job_id: 'abc123' }),
    ),
    ultimo: vi.fn(async (id: string) => jobs[id] ?? null),
    velas: vi.fn(async (consulta: ConsultaVelas) => velasFalsas(consulta)),
    ...patch,
  }
  // The mocks keep their spy methods (`mockImplementation`...) while the whole still is an `EstrategiasApi`.
  return api as Mocked<EstrategiasApi>
}
