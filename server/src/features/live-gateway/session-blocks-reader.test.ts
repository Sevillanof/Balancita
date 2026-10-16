import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

/** Heartbeat of the run that wrote `document`, next to its blocks file. */
function heartbeatFor(path: string, document: Loose, over: Loose = {}): string {
  const beat = join(dirname(path), 'heartbeat.json')
  writeFileSync(
    beat,
    JSON.stringify({
      session_id: document.session_id,
      config_digest: document.config_digest,
      pid: document.run.pid,
      run_id: document.run.id,
      ...over,
    }),
  )
  return beat
}

/** Reads a scenario as the route does: blocks file plus its own run's heartbeat. */
function read(name: string, nowMs: number, over: Loose = {}) {
  const doc = scenarios[name]
  const path = publish(doc, T0)
  return readSessionBlocks(path, nowMs, heartbeatFor(path, doc, over))
}

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
    for (const [doc, reason] of cases) {
      const path = publish(doc, T0)
      expect(
        readSessionBlocks(path, T0, heartbeatFor(path, base)),
        reason,
      ).toEqual({ state: 'invalid', reason })
    }
  })

  it('a running session is never alive/fresh from the file alone', () => {
    const doc = ok(read('operating_threshold_hypothesis', T0 + 1_000))
    expect(doc.status.liveness).toBe('unknown')
    expect(doc.status.phase).toBe('LIVE')
    expect(doc.status.gateway).toEqual({ age_ms: 1_000, reason: null })
    expect(doc.positions.verification.freshness).not.toBe('fresh')
  })

  it('old state: older than the limit the publisher carries is stale/unverified', () => {
    const doc = ok(read('operating_threshold_hypothesis', T0 + 16_000))
    expect(doc.status.liveness).toBe('stale')
    expect(doc.status.phase).toBe('unverified')
    expect(doc.status.reported_phase).toBe('LIVE')
    expect(doc.status.reasons).toContain('heartbeat_stale')
    expect(doc.status.gateway.reason).toBe('heartbeat_age_over_limit')
  })

  it('no limit in the block: no default is invented', () => {
    const doc = ok(read('operating_no_threshold', T0 + 999_000_000))
    expect(doc.status.liveness).toBe('unknown')
    expect(doc.status.phase).toBe('LIVE')
    expect(doc.status.gateway.reason).toBe('threshold_missing')
  })

  it('a clock going back leaves the age unknown, not zero', () => {
    const doc = ok(read('operating_threshold_hypothesis', T0 - 5_000))
    expect(doc.status.gateway).toEqual({
      age_ms: null,
      reason: 'heartbeat_age_unknown',
    })
  })

  it('stop and halt: final phases are left alone however old the file is', () => {
    for (const name of ['stopped_orderly', 'halted_funding_diverged']) {
      const doc = ok(read(name, T0 + 10 ** 9))
      expect(doc.status.phase).toBe(scenarios[name].status.phase)
      expect(doc.status.liveness).toBe('final')
      expect(doc.status.gateway).toBeNull()
    }
  })

  it('a document built without a heartbeat has no run to confirm and is refused', () => {
    const doc = scenarios.without_status
    const path = publish(doc, T0)
    expect(
      readSessionBlocks(
        path,
        T0,
        heartbeatFor(path, scenarios.stopped_orderly),
      ),
    ).toEqual({ state: 'invalid', reason: 'other_run' })
  })

  it('restart: a file of the previous run is refused even with a recent mtime', () => {
    const doc = scenarios.operating_threshold_hypothesis
    const path = publish(doc, T0)
    const fresh = T0 + 1_000
    // The new run left its heartbeat; the old blocks file is still there.
    for (const over of [
      { pid: doc.run.pid + 1 },
      { run_id: 'another-start-same-pid' },
      { session_id: 'another-session' },
      { config_digest: 'another-digest' },
    ])
      expect(
        readSessionBlocks(path, fresh, heartbeatFor(path, doc, over)),
        JSON.stringify(over),
      ).toEqual({ state: 'invalid', reason: 'other_run' })
    // No heartbeat at all, or an unreadable one: the run cannot be confirmed.
    expect(readSessionBlocks(path, fresh)).toEqual({
      state: 'invalid',
      reason: 'other_run',
    })
    expect(
      readSessionBlocks(path, fresh, join(dirname(path), 'missing.json')),
    ).toEqual({ state: 'invalid', reason: 'other_run' })
    // The same run is accepted.
    expect(readSessionBlocks(path, fresh, heartbeatFor(path, doc)).state).toBe(
      'ok',
    )
  })

  it('restart with the same pid, session and configuration: the previous start’s file is refused', () => {
    const doc = scenarios.operating_threshold_hypothesis
    const path = publish(doc, T0)
    const sameEverythingButTheStart = heartbeatFor(path, doc, {
      run_id: 'the-new-start',
    })
    expect(
      readSessionBlocks(path, T0 + 1_000, sameEverythingButTheStart),
    ).toEqual({ state: 'invalid', reason: 'other_run' })
    // a heartbeat from before run ids existed is not enough to accept a file either
    const noRunId = heartbeatFor(path, doc, { run_id: undefined })
    expect(readSessionBlocks(path, T0 + 1_000, noRunId)).toEqual({
      state: 'invalid',
      reason: 'other_run',
    })
  })

  it('republishing restarts the age', () => {
    const doc = scenarios.operating_threshold_hypothesis
    const path = publish(doc, T0)
    const beat = heartbeatFor(path, doc)
    expect(ok(readSessionBlocks(path, T0 + 60_000, beat)).status.liveness).toBe(
      'stale',
    )
    utimesSync(path, (T0 + 59_000) / 1000, (T0 + 59_000) / 1000)
    expect(ok(readSessionBlocks(path, T0 + 60_000, beat)).status.liveness).toBe(
      'unknown',
    )
  })

  it('never writes: the files are byte-identical after reading', () => {
    const doc = scenarios.operating_threshold_hypothesis
    const path = publish(doc, T0)
    const beat = heartbeatFor(path, doc)
    const before = [readFileSync(path), readFileSync(beat)]
    readSessionBlocks(path, T0 + 1, beat)
    expect(readFileSync(path).equals(before[0])).toBe(true)
    expect(readFileSync(beat).equals(before[1])).toBe(true)
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

// The two files a REAL Supervisor (python/tests/session_e2e_187.py) left in an invented session
// with a simulated clock: what Python writes is what the server reads.
const REAL = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../docs/mission-control/b3/sesion-supervisor-sintetica-187.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Record<string, { blocks: Loose; heartbeat: Loose }>

function placeFiles(name: string, publishedAtMs: number) {
  const path = publish(REAL[name].blocks, publishedAtMs)
  const beat = join(dirname(path), 'heartbeat.json')
  writeFileSync(beat, JSON.stringify(REAL[name].heartbeat))
  return { path, beat }
}

describe('the server reads what a real Supervisor wrote (synthetic session)', () => {
  it('operation: the running session is read, not alive, with the age of its publication', () => {
    const { path, beat } = placeFiles('operating', T0)
    const reading = readSessionBlocks(path, T0 + 2_000, beat)
    const doc = ok(reading)
    expect(doc.status.phase).toBe('LIVE')
    expect(doc.status.liveness).toBe('unknown')
    expect(doc.status.gateway).toEqual({
      age_ms: 2_000,
      reason: 'threshold_missing',
    })
    expect(doc.run.id).toBe(REAL.operating.heartbeat.run_id)
    // The reading the page gets: a committed snapshot, decoded by the frontend test.
    return expect(JSON.stringify(reading, null, 2) + '\n').toMatchFileSnapshot(
      '../../../../docs/mission-control/b3/lectura-servidor-operando-187.json',
    )
  })

  it('stop: the orderly stop is read as final', () => {
    const { path, beat } = placeFiles('stopped', T0)
    const reading = readSessionBlocks(path, T0 + 10 ** 9, beat)
    const doc = ok(reading)
    expect(doc.status.phase).toBe('STOPPED')
    expect(doc.status.liveness).toBe('final')
    return expect(JSON.stringify(reading, null, 2) + '\n').toMatchFileSnapshot(
      '../../../../docs/mission-control/b3/lectura-servidor-detenida-187.json',
    )
  })

  it('restart (operator): the new start publishes, its pair is read as the new run', () => {
    const { path, beat } = placeFiles('restart_published', T0)
    const reading = readSessionBlocks(path, T0 + 1_000, beat)
    expect(ok(reading).run.id).toBe('run-synthetic-0002')
    return expect(JSON.stringify(reading, null, 2) + '\n').toMatchFileSnapshot(
      '../../../../docs/mission-control/b3/lectura-servidor-reinicio-publicado-187.json',
    )
  })

  it('restart (operator) whose first publication failed: same pid, session and configuration, the cut run’s file is refused', () => {
    const { path, beat } = placeFiles('restart_publication_failed', T0)
    expect(REAL.restart_publication_failed.heartbeat.pid).toBe(
      REAL.restart_publication_failed.blocks.run.pid,
    )
    expect(REAL.restart_publication_failed.heartbeat.session_id).toBe(
      REAL.restart_publication_failed.blocks.session_id,
    )
    expect(REAL.restart_publication_failed.heartbeat.config_digest).toBe(
      REAL.restart_publication_failed.blocks.config_digest,
    )
    expect(REAL.restart_publication_failed.heartbeat.publication.failures).toBe(
      1,
    )
    const reading = readSessionBlocks(path, T0 + 1_000, beat)
    expect(reading).toEqual({ state: 'invalid', reason: 'other_run' })
    return expect(JSON.stringify(reading, null, 2) + '\n').toMatchFileSnapshot(
      '../../../../docs/mission-control/b3/lectura-servidor-reinicio-fallido-187.json',
    )
  })
})
