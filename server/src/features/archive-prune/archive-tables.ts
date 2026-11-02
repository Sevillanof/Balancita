/**
 * Tablas cuyo archivo Parquet permite borrar de SQLite, y las que NO.
 * Una tabla solo se borra desde el proceso que ya es dueño de su base (el único escritor).
 */
export interface ArchiveTableSpec {
  /** Nombre de la tabla en el archivo (campo `tabla` del manifiesto). */
  readonly table: string
  readonly sqliteTable: string
  /** Nombre de la base en el archivo (campo `base` del manifiesto) y de su copia diaria. */
  readonly base: string
  readonly timeColumn: string
  readonly granularity: 'day' | 'month'
  /** Datos más nuevos que esto se quedan en SQLite (la ventana de retención de la tabla). */
  readonly retentionMs: number
  /** `formato_version` mínimo que debe traer la línea del manifiesto; con un formato más viejo no se borra. */
  readonly minFormatVersion: number
}

const DAY = 86_400_000

/**
 * Versión mínima del formato exigida a toda línea del manifiesto. El exportador actual NO escribe `formato_version`
 * ni `verificacion_ida_vuelta`: nada archivado hasta hoy se puede borrar hasta que el exportador nuevo
 * (formato óptimo por tabla) lo certifique y se suba este número en el cambio que lo traiga.
 */
export const MIN_FORMAT_VERSION = 2

/** Dueño: el recolector de posicionamiento (`positioning-collector`), único escritor de `positioning.sqlite`. Sin triggers de inmutabilidad. */
export const POSITIONING_TABLES: readonly ArchiveTableSpec[] = [
  {
    table: 'positioning',
    sqliteTable: 'positioning',
    base: 'positioning',
    timeColumn: 'bucket_ms',
    granularity: 'month',
    retentionMs: 30 * DAY,
    minFormatVersion: MIN_FORMAT_VERSION,
  },
  {
    table: 'premium',
    sqliteTable: 'premium',
    base: 'positioning',
    timeColumn: 'bucket_ms',
    granularity: 'month',
    retentionMs: 30 * DAY,
    minFormatVersion: MIN_FORMAT_VERSION,
  },
]

/** Fuera del borrado por archivo, y por qué (se muestra en el log de arranque y está en docs/operacion-base-de-datos.md). */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  verdicts:
    'la escribe un proceso Python (futures_verdicts) y tiene trigger no_delete (inmutable): no se borra desde la captura',
  llm_decisions:
    'la escribe un proceso Python (futures_llm_decisions) y tiene trigger no_delete: no se borra desde la captura',
  forecasts:
    'la escribe un proceso Python (futures_forecast_scores) y tiene trigger no_delete',
  forecast_returns: 'ídem forecasts',
  forecast_barriers: 'ídem forecasts',
  forecast_excursions: 'ídem forecasts',
  market_events:
    'la captura ya la recorta sola (retención de eventos, 7 días por defecto) y tiene triggers; el archivo no cambia esa ventana',
  news_items: 'las noticias NO se borran nunca',
  news_analysis: 'las noticias NO se borran nunca',
}
