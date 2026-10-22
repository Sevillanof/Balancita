import { record } from '../shared/wire/decode.ts'

export function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const decimal = (value: number, digits = 0) =>
  value.toLocaleString('es-ES', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })

export interface UsageSummary {
  readonly cpu: string
  readonly data: string
  readonly qwen: string
  readonly kronos: string
  readonly title: string
}

const nonnegative = (value: unknown) => {
  const parsed = number(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

/** Source clocks must agree with both the response and the advancing UI clock. */
export function summarizeUsage(body: unknown, now = Date.now()): UsageSummary {
  const usage = record(body)
  const at = nonnegative(usage.at_ms)
  const cached = nonnegative(usage.cached_at_ms)
  const envelope =
    usage.schema === 'system-usage.v1' &&
    at !== null &&
    at <= now &&
    cached !== null &&
    cached <= at
  const fresh = (value: unknown, limit: number) => {
    const time = nonnegative(value)
    return (
      envelope &&
      time !== null &&
      at !== null &&
      time <= at &&
      now - time <= limit
    )
  }
  const age = (value: unknown) => {
    const time = nonnegative(value)
    return time === null || time > now
      ? 'sin fecha válida'
      : `hace ${decimal((now - time) / 1000)} s`
  }
  const supervisor = fresh(usage.supervisor_updated_at_ms, 30_000)
  const valid =
    usage.status === 'ok' &&
    supervisor &&
    fresh(usage.sampled_at_ms, 15_000) &&
    nonnegative(usage.cpu_pct) !== null &&
    nonnegative(usage.rss_mb) !== null
  const cpu = valid ? nonnegative(usage.cpu_pct) : null
  const rss = valid ? nonnegative(usage.rss_mb) : null
  const running = (value: unknown, current: boolean) => {
    if (!current) return '—'
    return value === true ? 'activo' : value === false ? 'apagado' : '—'
  }
  const qwen = running(record(usage.qwen).running, supervisor)
  const kronos = running(record(usage.kronos).running, valid)
  const storage = record(usage.storage)
  const total = nonnegative(storage.total_bytes)
  const storageValid =
    fresh(storage.sampled_at_ms, 15_000) &&
    storage.scope === 'configured_data_directory' &&
    total !== null &&
    (storage.status === 'ok' || storage.status === 'partial')
  const lowerBound = storage.status === 'partial' || storage.complete !== true
  const data =
    storageValid && total !== null
      ? `${lowerBound ? '≥' : ''}${decimal(total / 1_048_576, 1)} MiB`
      : '—'
  const bytes = record(storage.bytes)
  const categories = [
    ['sqlite_main', 'SQLite'],
    ['wal', 'WAL'],
    ['shm', 'SHM'],
    ['log', 'logs'],
    ['other', 'otros'],
  ]
    .map(([key, label]) => {
      const value = nonnegative(bytes[key])
      return `${label}: ${value === null ? '—' : `${lowerBound ? '≥' : ''}${decimal(value)} B`}`
    })
    .join(', ')
  const resourceState =
    body == null
      ? 'sin fuente'
      : valid
        ? age(usage.sampled_at_ms)
        : `no disponible: muestra obsoleta, inválida o fallida (${String(usage.reason ?? 'sin evidencia válida')})`
  return {
    cpu: cpu === null ? '—' : `${decimal(cpu)} %`,
    data,
    qwen,
    kronos,
    title: [
      `Recursos: ${resourceState}; vigencia 15 s; supervisor 30 s.`,
      `Respuesta: ${age(usage.at_ms)}; caché: ${age(usage.cached_at_ms)}.`,
      `CPU: ${cpu === null ? 'no disponible' : `${decimal(cpu)} % de un núcleo; puede superar 100 %`}.`,
      `Memoria: ${rss === null ? 'no disponible' : `${decimal(rss)} MiB`}; RSS sumada en MiB, no memoria única ni GPU.`,
      'Total: PID únicos de grupos supervisados o Kronos; los grupos pueden solaparse, no indican propiedad.',
      `Almacenamiento: ${data}; solo directorio configurado; ${age(storage.sampled_at_ms)}; vigencia 15 s.`,
      storageValid
        ? `${lowerBound ? 'Parcial, límite inferior' : 'Inventario completo dentro del alcance'}: ${categories}.`
        : 'Inventario no disponible: ausente, fallido, obsoleto o inválido.',
      `Límites: ${number(storage.max_entries) ?? '—'} entradas, profundidad ${number(storage.max_depth) ?? '—'}; motivo: ${String(storage.reason ?? '—')}.`,
      'Excluye modelos, otras raíces y enlaces simbólicos. Tamaños de archivos, no datos lógicos útiles ni liberables; no capacidad total ni espacio libre del sistema de archivos.',
      `Qwen: ${qwen}; estado del supervisor ${age(usage.supervisor_updated_at_ms)}; decisiones/latencia sin fuente acotada.`,
      `Kronos: ${kronos}; estado de la muestra de recursos; recuentos de operaciones y salidas omitidos por no tener vigencia verificable.`,
    ].join('\n'),
  }
}
