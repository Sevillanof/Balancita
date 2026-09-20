import { describe, expect, it } from 'vitest'
import type { Alert } from '../domain/alerts'
import {
  evaluateAlert,
  nextZoneAfterAcknowledge,
  sideOf,
} from './alert-evaluator'

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a1',
    instrumentId: 'BTC-EUR',
    direction: 'above',
    thresholdPrice: 60_000,
    status: 'active',
    createdAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  }
}

describe('sideOf', () => {
  it('classifies an above alert side strictly above its threshold', () => {
    expect(sideOf(makeAlert(), 60_001)).toBe('above')
    expect(sideOf(makeAlert(), 60_000)).toBe('below')
    expect(sideOf(makeAlert(), 59_999)).toBe('below')
  })

  it('classifies a below alert side strictly below its threshold', () => {
    const alert = makeAlert({ direction: 'below' })
    expect(sideOf(alert, 59_999)).toBe('below')
    expect(sideOf(alert, 60_000)).toBe('above')
    expect(sideOf(alert, 60_001)).toBe('above')
  })
})

describe('evaluateAlert cold start', () => {
  it('initializes the zone on the first quote without firing', () => {
    const result = evaluateAlert(makeAlert(), null, 59_000)
    expect(result.event).toBe('init')
    expect(result).toMatchObject({ status: 'active', zone: 'below' })
  })

  it('does not fire at startup even when the price is already beyond the threshold', () => {
    const result = evaluateAlert(makeAlert(), null, 65_000)
    expect(result.event).toBe('init')
  })

  it('does not fire at startup for a below alert already beyond the threshold', () => {
    const result = evaluateAlert(
      makeAlert({ direction: 'below' }),
      null,
      55_000,
    )
    expect(result.event).toBe('init')
  })
})

describe('evaluateAlert crossings', () => {
  it('fires an above alert on a below to above crossing', () => {
    const result = evaluateAlert(makeAlert(), 'below', 60_001)
    expect(result.event).toBe('trigger')
    expect(result.status).toBe('triggered')
    expect(result.zone).toBe('above')
  })

  it('does not fire an above alert that is already above (same crossing)', () => {
    expect(evaluateAlert(makeAlert(), 'above', 65_000).event).toBe('none')
    expect(evaluateAlert(makeAlert(), 'above', 60_001).event).toBe('none')
  })

  it('does not fire an above alert when the price only touches the threshold', () => {
    const result = evaluateAlert(makeAlert(), 'below', 60_000)
    expect(result.event).toBe('none')
    expect(result.zone).toBe('below')
  })

  it('fires a below alert on an above to below crossing', () => {
    const result = evaluateAlert(
      makeAlert({ direction: 'below' }),
      'above',
      59_999,
    )
    expect(result.event).toBe('trigger')
    expect(result.status).toBe('triggered')
    expect(result.zone).toBe('below')
  })

  it('does not fire a below alert that is already below (same crossing)', () => {
    expect(
      evaluateAlert(makeAlert({ direction: 'below' }), 'below', 55_000).event,
    ).toBe('none')
  })

  it('does not fire a below alert when the price only touches the threshold', () => {
    const result = evaluateAlert(
      makeAlert({ direction: 'below' }),
      'above',
      60_000,
    )
    expect(result.event).toBe('none')
    expect(result.zone).toBe('above')
  })

  it('tracks the zone back through a pullback before re-crossing', () => {
    const alert = makeAlert()
    expect(evaluateAlert(alert, 'above', 59_000).event).toBe('none')
    expect(evaluateAlert(alert, 'below', 59_000).event).toBe('none')
  })
})

describe('evaluateAlert reactivation', () => {
  it('fires an acknowledged alert under the same rules as an active one', () => {
    const acknowledged = makeAlert({ status: 'acknowledged' })
    const active = makeAlert()
    const coldStart = evaluateAlert(acknowledged, null, 59_000)
    expect(coldStart.event).toBe('init')
    expect(coldStart.zone).toBe(evaluateAlert(active, null, 59_000).zone)
    expect(evaluateAlert(acknowledged, 'below', 60_001).event).toBe('trigger')
    expect(evaluateAlert(acknowledged, 'above', 60_001).event).toBe('none')
  })

  it('re-arms an acknowledged below alert so it only fires on the next crossing', () => {
    const acknowledged = makeAlert({
      direction: 'below',
      status: 'acknowledged',
    })

    const rearmed = evaluateAlert(acknowledged, 'below', 55_000)
    expect(rearmed.event).toBe('none')
    const pullback = evaluateAlert(acknowledged, 'above', 60_001)
    expect(pullback.event).toBe('none')
    const nextCrossing = evaluateAlert(acknowledged, 'above', 59_999)
    expect(nextCrossing.event).toBe('trigger')
  })
})

describe('nextZoneAfterAcknowledge', () => {
  it('anchors the zone to the current price side', () => {
    expect(nextZoneAfterAcknowledge(makeAlert(), 61_000)).toBe('above')
    expect(nextZoneAfterAcknowledge(makeAlert(), 59_000)).toBe('below')
    expect(
      nextZoneAfterAcknowledge(makeAlert({ direction: 'below' }), 59_000),
    ).toBe('below')
  })

  it('returns null when no price is known so the next quote cold-starts safely', () => {
    expect(nextZoneAfterAcknowledge(makeAlert(), null)).toBeNull()
  })
})

describe('evaluateAlert multiple alerts on the same instrument', () => {
  it('evaluates each alert independently with its own zone', () => {
    const above = makeAlert({ id: 'a1' })
    const below = makeAlert({ id: 'a2', direction: 'below' })

    const onSameQuote = [above, below].map((alert) =>
      evaluateAlert(alert, null, 61_000),
    )
    expect(onSameQuote[0]).toMatchObject({ event: 'init', zone: 'above' })
    expect(onSameQuote[1]).toMatchObject({ event: 'init', zone: 'above' })
  })

  it('triggering one alert does not affect the other on the same instrument', () => {
    const above = makeAlert({ id: 'a1' })
    const below = makeAlert({ id: 'a2', direction: 'below' })

    const first = evaluateAlert(above, 'below', 61_000)
    expect(first.event).toBe('trigger')

    const second = evaluateAlert(below, 'below', 55_000)
    expect(second.event).toBe('none')

    const again = evaluateAlert(above, 'above', 65_000)
    expect(again.event).toBe('none')
  })
})
