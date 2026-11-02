import { describe, expect, it } from 'vitest'
import { createWakeDetector, type WakeEvent } from './wake-detector.ts'

function rig(gapMs = 120_000) {
  let wall = 1_000_000
  let mono = 5_000
  const events: WakeEvent[] = []
  const detector = createWakeDetector({
    gapMs,
    wall: () => wall,
    monotonic: () => mono,
    onWake: (e) => events.push(e),
  })
  return {
    detector,
    events,
    /** Normal time: both clocks advance. */
    run: (ms: number) => {
      wall += ms
      mono += ms
    },
    /** The machine sleeps: only the wall clock advances. */
    sleep: (ms: number) => {
      wall += ms
    },
    setBack: (ms: number) => {
      wall -= ms
    },
  }
}

describe('wake detector', () => {
  it('stays quiet while ticks arrive on time', () => {
    const r = rig()
    for (let i = 0; i < 100; i += 1) {
      r.run(5_000)
      expect(r.detector.tick()).toBeUndefined()
    }
    expect(r.events).toEqual([])
  })

  it('sees a night of sleep as the difference between the wall and the monotonic clock', () => {
    const r = rig()
    r.run(5_000)
    r.detector.tick()
    r.sleep(8 * 3_600_000)
    r.run(5_000)
    const event = r.detector.tick()
    expect(event).toMatchObject({ kind: 'sleep' })
    expect(event?.sleptMs).toBeGreaterThan(7.9 * 3_600_000)
    expect(r.events).toHaveLength(1)
    // It fires once: the next normal tick is quiet.
    r.run(5_000)
    expect(r.detector.tick()).toBeUndefined()
  })

  it('treats a gap above 2 minutes between ticks as a wake-up even when both clocks agree', () => {
    const r = rig()
    r.run(121_000)
    expect(r.detector.tick()).toMatchObject({ kind: 'stall' })
  })

  it('ignores a gap just under the limit and reports a clock set back', () => {
    const r = rig()
    r.run(119_000)
    expect(r.detector.tick()).toBeUndefined()
    r.setBack(10 * 60_000)
    expect(r.detector.tick()).toMatchObject({ kind: 'clock' })
  })
})
