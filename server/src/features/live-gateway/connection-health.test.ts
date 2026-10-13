import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConnectionHealth } from './connection-health.ts'

const incident = (component: string) => ({
  component,
  product: null,
  reason: 'poll_stuck',
  action: 'abort_and_rearm',
  result: 'recovering' as const,
})

describe('ConnectionHealth', () => {
  it('calls it general only when distinct sources fail together, and forgets after the window', () => {
    let now = 0
    const health = new ConnectionHealth({
      clock: () => now,
      generalThreshold: 3,
      generalWindowMs: 60_000,
    })
    health.report(incident('a'))
    health.report(incident('a'))
    health.report(incident('b'))
    expect(health.general()).toBe(false)
    health.report(incident('c'))
    expect(health.general()).toBe(true)
    expect(health.freshConnections()).toBe(true)
    now = 61_000
    expect(health.general()).toBe(false)
    expect(health.freshConnections()).toBe(true)
    now = 200_000
    expect(health.freshConnections()).toBe(false)
  })

  it('does not count recoveries as incidents', () => {
    const health = new ConnectionHealth({ generalThreshold: 2 })
    health.report({ ...incident('a'), result: 'recovered' })
    health.report({ ...incident('b'), result: 'recovered' })
    expect(health.general()).toBe(false)
  })

  it('rate limits forced recoveries per source', () => {
    let now = 0
    const health = new ConnectionHealth({
      clock: () => now,
      minRecoveryGapMs: 5_000,
    })
    expect(health.allowRecovery('ws')).toBe(true)
    expect(health.allowRecovery('ws')).toBe(false)
    expect(health.allowRecovery('other')).toBe(true)
    now = 5_000
    expect(health.allowRecovery('ws')).toBe(true)
  })

  it('writes one JSON line per event and survives an unwritable log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-health-'))
    try {
      const file = join(dir, 'resilience.jsonl')
      new ConnectionHealth({ logFile: file, clock: () => 7 }).report(
        incident('a'),
      )
      const line = JSON.parse(readFileSync(file, 'utf8').trim())
      expect(line).toMatchObject({
        at: 7,
        component: 'a',
        reason: 'poll_stuck',
      })
      expect(() =>
        new ConnectionHealth({
          logFile: join(dir, 'no', 'such', 'dir'),
        }).report(incident('a')),
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
