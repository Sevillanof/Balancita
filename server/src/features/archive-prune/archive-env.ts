import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Interruptor del borrado de lo archivado. APAGADO por defecto: lo enciende Fran a mano.
 * FUTURES_ARCHIVE_DELETE=1 borra; =dry-run solo informa en retention.jsonl qué borraría.
 */
export function archiveModeFromEnv(
  env: NodeJS.ProcessEnv,
): 'off' | 'dry-run' | 'delete' {
  const value = env.FUTURES_ARCHIVE_DELETE?.trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'on') return 'delete'
  if (value === 'dry-run' || value === 'dryrun') return 'dry-run'
  return 'off'
}

/** FUTURES_ARCHIVE_REQUIRE_OFFSITE=1: además de confirmado en el manifiesto, exige `confirmado_fuera` (hoy apagado: no hay VPS). */
export function requireOffsiteFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.FUTURES_ARCHIVE_REQUIRE_OFFSITE?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'on'
}

/** Misma carpeta que usa la exportación nocturna (BALANCITA_ARCHIVO_DESTINO). */
export function archiveDirFromEnv(env: NodeJS.ProcessEnv): string {
  return (
    env.BALANCITA_ARCHIVO_DESTINO ||
    join(homedir(), 'balancita-data.noindex', 'archivo-parquet')
  )
}
