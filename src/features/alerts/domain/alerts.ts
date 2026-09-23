import type { InstrumentId } from '../../market-data/domain/market-data.ts'

export type AlertId = string

export type AlertDirection = 'above' | 'below'

/**
 * Lifecycle of a local price alert.
 *
 * - `active`: newly created and never triggered. Armed and evaluates quotes.
 * - `triggered`: a genuine threshold crossing was detected; the alert is frozen
 *   and no longer evaluates until the user acknowledges it.
 * - `acknowledged`: re-armed after the user acknowledged the last trigger; it
 *   evaluates exactly like `active` but keeps the "already acknowledged" badge.
 *   The evaluation zone is reset on acknowledge, so it only fires again on the
 *   NEXT genuine crossing (never for the same one).
 */
export type AlertStatus = 'active' | 'triggered' | 'acknowledged'

/**
 * Local price alert configuration. Only this is persisted and restored: price
 * zones, quotes and crossing history are runtime state owned by the evaluator
 * and are never stored.
 */
export type Alert = {
  id: AlertId
  instrumentId: InstrumentId
  direction: AlertDirection
  thresholdPrice: number
  status: AlertStatus
  createdAt: string
}

/**
 * Persistence contract for local price alerts. Async and deliberately small so
 * a different backend could replace localStorage without touching the UI.
 */
export interface AlertRepository {
  /** Returns all stored alerts, or an empty list when none exist. */
  list(): Promise<readonly Alert[]>
  /**
   * Creates the alert, or replaces the existing one with the same id.
   * Storage failures reject the promise.
   */
  add(alert: Alert): Promise<void>
  /** Removes the alert for the given id, if present. */
  remove(id: AlertId): Promise<void>
  /** Removes every stored alert. */
  clear(): Promise<void>
}

/**
 * Raised when stored alert data exists but cannot be trusted: invalid JSON,
 * unsupported schema version, or a malformed alert. The UI must surface this
 * explicitly and offer a reset instead of silently trusting garbage.
 */
export class AlertCorruptError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AlertCorruptError'
  }
}

const DIRECTIONS: readonly AlertDirection[] = ['above', 'below']
const STATUSES: readonly AlertStatus[] = ['active', 'triggered', 'acknowledged']

/** Loose shape guard for an alert read from untrusted storage. */
export function isAlert(value: unknown): value is Alert {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.instrumentId === 'string' &&
    candidate.instrumentId.length > 0 &&
    typeof candidate.direction === 'string' &&
    DIRECTIONS.includes(candidate.direction as AlertDirection) &&
    typeof candidate.thresholdPrice === 'number' &&
    Number.isFinite(candidate.thresholdPrice) &&
    candidate.thresholdPrice > 0 &&
    typeof candidate.status === 'string' &&
    STATUSES.includes(candidate.status as AlertStatus) &&
    typeof candidate.createdAt === 'string' &&
    Number.isFinite(Date.parse(candidate.createdAt))
  )
}
