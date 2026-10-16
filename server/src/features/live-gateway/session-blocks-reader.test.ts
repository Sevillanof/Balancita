import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { degradeStatus, readSessionBlocks } from './session-blocks-reader.ts'

// SYNTHETIC document the real publisher builds from invented sessions (#187).
const FIXTURE = fileURLToPath(
  new URL(
    '../../../../docs/mission-control/b3/documento-bloques-publicador-real.json',
    import.meta.url,
  ),
)
// Test documents are read loosely: the assertions name the keys they check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>

const scenarios = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<
  string,
  Loose
>

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function publish(document: unknown, publishedAtMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'blocks-'))
  dirs.push(dir)
  const path = join(dir, 'blocks.json')
  writeFileSync(
    path,
    typeof document === 'string' ? document : JSON.stringify(document),
  )
  utimesSync(path, publishedAtMs / 1000, publishedAtMs / 1000)
  return path
}

const T0 = 1_800_000_000_000

function ok(reading: ReturnType<typeof readSessionBlocks>) {
  if (reading.state !== 'ok')
    throw new Error(`expected ok, got ${reading.state}`)
  return reading.document as Loose
}

describe('readSessionBlocks: a derived file read with the server clock', () => {
  it('absent: no file is reported absent, never an empty session', () => {
    expect(readSessionBlocks(join(tmpdir(), 'nope-187.json'), T0)).toEqual({
      state: 'absent',
    })
  })

  it('invalid: garbage, unknown schema, not derived, missing block', () => {
    const base = scenarios.operating_threshold_hypothesis
    const cases: Array<[unknown, string]> = [
      ['{not json', 'not_json'],
      [{ ...base, schema: 'other.v1' }, 'schema_unknown'],
      [{ ...base, authority: 'trade' }, 'not_derived'],
      [{ ...base, derived: false }, 'not_derived'],
      [{ ...base, status: null }, 'block_missing'],
      [{ ...base, positions: { schema: 'x' } }, 'block_shape'],
    ]
    for (const [doc, reason] of cases)
      expect(readSessionBlocks(publish(doc, T0), T0)).toEqual({
        state: 'invalid',
        reason,
      })
  })

  it('a running session is never alive/fresh from the file alone', () => {
    const doc = ok(
      readSessionBlocks(
        publish(scenarios.operating_threshold_hypothesis, T0),
        T0 + 1_000,
      ),
    )
    expect(doc.status.liveness).toBe('unknown')
    expect(doc.status.phase).toBe('LIVE')
    expect(doc.status.gateway).toEqual({
      age_ms: 1_000,
      reason: null,
    })
    expect(doc.positions.verification.freshness).not.toBe('fresh')
  })

  it('old state: older than the limit the publisher carries is stale/unverified', () => {
    const doc = ok(
      readSessionBlocks(
        publish(scenarios.operating_threshold_hypothesis, T0),
        T0 + 16_000,
      ),
    )
    expect(doc.status.liveness).toBe('stale')
    expect(doc.status.phase).toBe('unverified')
    expect(doc.status.reported_phase).toBe('LIVE')
    expect(doc.status.reasons).toContain('heartbeat_stale')
    expect(doc.status.gateway.reason).toBe('heartbeat_age_over_limit')
  })

  it('no limit in the block: no default is invented', () => {
    const doc = ok(
      readSessionBlocks(
        publish(scenarios.operating_no_threshold, T0),
        T0 + 999_000_000,
      ),
    )
    expect(doc.status.liveness).toBe('unknown')
    expect(doc.status.phase).toBe('LIVE')
    expect(doc.status.gateway.reason).toBe('threshold_missing')
  })

  it('a clock going back leaves the age unknown, not zero', () => {
    const doc = ok(
      readSessionBlocks(
        publish(scenarios.operating_threshold_hypothesis, T0),
        T0 - 5_000,
      ),
    )
    expect(doc.status.gateway).toEqual({
      age_ms: null,
      reason: 'heartbeat_age_unknown',
    })
  })

  it('stop and halt: final phases are left alone however old the file is', () => {
    for (const name of ['stopped_orderly', 'halted_funding_diverged']) {
      const input = scenarios[name]
      const doc = ok(readSessionBlocks(publish(input, T0), T0 + 10 ** 9))
      expect(doc.status.phase).toBe(input.status.phase)
      expect(doc.status.liveness).toBe('final')
      expect(doc.status.gateway).toBeNull()
    }
  })

  it('unavailable status passes through as unavailable', () => {
    const doc = ok(
      readSessionBlocks(publish(scenarios.without_status, T0), T0 + 10 ** 9),
    )
    expect(doc.status.phase).toBe('unavailable')
    expect(doc.status.liveness).toBe('unknown')
  })

  it('restart: a republished file is read as new, the age restarts', () => {
    const path = publish(scenarios.operating_threshold_hypothesis, T0)
    expect(ok(readSessionBlocks(path, T0 + 60_000)).status.liveness).toBe(
      'stale',
    )
    utimesSync(path, (T0 + 59_000) / 1000, (T0 + 59_000) / 1000)
    expect(ok(readSessionBlocks(path, T0 + 60_000)).status.liveness).toBe(
      'unknown',
    )
  })

  it('never writes: the file is byte-identical after reading', () => {
    const path = publish(scenarios.operating_threshold_hypothesis, T0)
    const before = readFileSync(path)
    readSessionBlocks(path, T0 + 1)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('degradeStatus only degrades: an alive status without a limit is not kept alive', () => {
    const out = degradeStatus(
      { phase: 'LIVE', liveness: 'alive', reasons: [], thresholds: null },
      { nowMs: T0, publishedAtMs: T0 },
    )
    expect(out.liveness).toBe('unknown')
    expect((out.gateway as { reason: string }).reason).toBe('threshold_missing')
  })
})
