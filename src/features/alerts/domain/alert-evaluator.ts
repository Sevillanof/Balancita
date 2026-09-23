import type { Alert, AlertStatus } from './alerts.ts'

export type PriceSide = 'above' | 'below'

export type Evaluation =
  | { event: 'init'; status: AlertStatus; zone: PriceSide }
  | { event: 'trigger'; status: 'triggered'; zone: PriceSide }
  | { event: 'none'; status: AlertStatus; zone: PriceSide }

function triggerSideOf(alert: Pick<Alert, 'direction'>): PriceSide {
  return alert.direction === 'above' ? 'above' : 'below'
}

/**
 * Classifies the side of a price relative to an alert threshold. A price equal
 * to the threshold counts as the non-trigger side so a bare touch never fires.
 */
export function sideOf(
  alert: Pick<Alert, 'direction' | 'thresholdPrice'>,
  price: number,
): PriceSide {
  if (alert.direction === 'above') {
    return price > alert.thresholdPrice ? 'above' : 'below'
  }
  return price < alert.thresholdPrice ? 'below' : 'above'
}

/**
 * Pure, deterministic crossing evaluation for a single armed alert.
 *
 * - A null zone is a cold start: the first quote only initializes the zone and
 *   never fires, which prevents spurious notifications on reload.
 * - An armed alert fires only on a genuine crossing INTO its trigger side:
 *   `above` needs a below -> above transition, `below` an above -> below one.
 *   Staying in the trigger side never re-fires for the same crossing.
 * - The zone always tracks the latest price side, so `acknowledged` alerts are
 *   re-armed and fire again only on the next real crossing.
 */
export function evaluateAlert(
  alert: Pick<Alert, 'direction' | 'thresholdPrice' | 'status'>,
  zone: PriceSide | null,
  price: number,
): Evaluation {
  const side = sideOf(alert, price)
  if (zone === null) {
    return { event: 'init', status: alert.status, zone: side }
  }
  const fired = side !== zone && side === triggerSideOf(alert)
  if (fired) {
    return { event: 'trigger', status: 'triggered', zone: side }
  }
  return { event: 'none', status: alert.status, zone: side }
}

/**
 * Zone for a freshly acknowledged alert: anchored to the current price side,
 * or null when no price is known yet (the next quote cold-starts safely).
 */
export function nextZoneAfterAcknowledge(
  alert: Pick<Alert, 'direction' | 'thresholdPrice'>,
  price: number | null,
): PriceSide | null {
  return price === null ? null : sideOf(alert, price)
}
