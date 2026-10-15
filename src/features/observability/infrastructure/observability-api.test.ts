/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON fixtures */
import { describe, expect, it } from 'vitest'
import healthDegraded from '../../../../docs/mission-control/b1/ejemplo-degradado.json'
import healthHealthy from '../../../../docs/mission-control/b1/ejemplo-saludable.json'
import healthNoData from '../../../../docs/mission-control/b1/ejemplo-sin-datos.json'
import activityBusy from '../../../../docs/mission-control/b2/ejemplo-con-actividad.json'
import activityNoData from '../../../../docs/mission-control/b2/ejemplo-sin-datos.json'
import activityQuiet from '../../../../docs/mission-control/b2/ejemplo-sin-actividad.json'
import { decodeActivity, decodeHealth } from './observability-api.ts'

/**
 * The decoders against the documented examples the backend tests generate from
 * its own code, and against shapes the contract does not define. Ported from
 * the tests of the discarded presentation in PR #147 (BAL-DECISION-147-02),
 * adapted to the decoders in main.
 */
const clone = <T>(value: T): any => JSON.parse(JSON.stringify(value))

describe('decodeHealth', () => {
  it('decodes the documented examples with their six components', () => {
    for (const example of [healthHealthy, healthDegraded, healthNoData])
      expect(decodeHealth(example).components).toHaveLength(6)
  })

  it('refuses a component status the contract does not define', () => {
    const bad = clone(healthHealthy)
    bad.components[0].status = 'great'
    expect(() => decodeHealth(bad)).toThrow(/component.status/)
  })

  it('refuses a response that is not the documented contract', () => {
    expect(() => decodeHealth({ schema: 'otra-cosa', components: [] })).toThrow(
      /schema/,
    )
  })
})

describe('decodeActivity', () => {
  it('decodes the documented examples with their window', () => {
    for (const example of [activityBusy, activityQuiet, activityNoData])
      expect(decodeActivity(example).window).toMatch(/3h|24h/)
  })

  it('refuses an activity section in an unknown state', () => {
    const bad = clone(activityBusy)
    bad.signals.state = 'maybe'
    expect(() => decodeActivity(bad)).toThrow(/signals.state/)
  })
})
