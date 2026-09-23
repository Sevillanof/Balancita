import {
  AlertCorruptError,
  isAlert,
  type Alert,
  type AlertId,
  type AlertRepository,
} from '../domain/alerts.ts'

export const ALERTS_STORAGE_KEY = 'balancita:alerts'
export const ALERTS_SCHEMA_VERSION = 1

type AlertStore = {
  version: number
  alerts: Alert[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStore(json: string): AlertStore {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (cause) {
    throw new AlertCorruptError('Stored alert data is not valid JSON.', cause)
  }

  if (!isRecord(parsed)) {
    throw new AlertCorruptError('Stored alert data is not an object payload.')
  }

  if (parsed.version !== ALERTS_SCHEMA_VERSION) {
    throw new AlertCorruptError(
      `Unsupported alert schema version: ${String(parsed.version)}.`,
    )
  }

  if (!Array.isArray(parsed.alerts)) {
    throw new AlertCorruptError(
      'Stored alert payload is missing its alerts list.',
    )
  }

  for (const alert of parsed.alerts) {
    if (!isAlert(alert)) {
      throw new AlertCorruptError('Stored alerts contain an invalid alert.')
    }
  }

  return { version: parsed.version, alerts: parsed.alerts }
}

/**
 * Local-first alert configuration persistence on top of localStorage. The
 * stored payload is the minimal `{ version, alerts }` — price zones, quotes and
 * crossing history are never persisted; the runtime derives them from the live
 * feed.
 *
 * Reading performs strict validation: missing storage is an empty alert list,
 * while existing-but-invalid data throws `AlertCorruptError` so the app can
 * offer an explicit reset instead of silently trusting garbage.
 */
export class LocalStorageAlertRepository implements AlertRepository {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>

  constructor(
    storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
  ) {
    this.storage = storage
  }

  async list(): Promise<readonly Alert[]> {
    const raw = this.storage.getItem(ALERTS_STORAGE_KEY)
    if (raw === null) return []
    return readStore(raw).alerts.map((alert) => ({ ...alert }))
  }

  async add(alert: Alert): Promise<void> {
    if (!isAlert(alert)) {
      throw new AlertCorruptError('Refusing to persist an invalid alert.')
    }
    const alerts = await this.readAlertsForWrite()
    const index = alerts.findIndex((existing) => existing.id === alert.id)
    if (index === -1) {
      alerts.push({ ...alert })
    } else {
      alerts[index] = { ...alert }
    }
    this.write(alerts)
  }

  async remove(id: AlertId): Promise<void> {
    const alerts = await this.currentAlerts()
    const remaining = alerts.filter((alert) => alert.id !== id)
    if (remaining.length !== alerts.length) {
      this.write(remaining)
    }
  }

  async clear(): Promise<void> {
    this.storage.setItem(
      ALERTS_STORAGE_KEY,
      JSON.stringify({ version: ALERTS_SCHEMA_VERSION, alerts: [] }),
    )
  }

  private write(alerts: Alert[]): void {
    this.storage.setItem(
      ALERTS_STORAGE_KEY,
      JSON.stringify({ version: ALERTS_SCHEMA_VERSION, alerts }),
    )
  }

  /** Reads all alerts for a read-modify-write cycle (for mutation ops). */
  private async readAlertsForWrite(): Promise<Alert[]> {
    return this.currentAlerts().then((alerts) =>
      alerts.map((alert) => ({ ...alert })),
    )
  }

  private async currentAlerts(): Promise<Alert[]> {
    const listed = await this.list()
    return [...listed]
  }
}
