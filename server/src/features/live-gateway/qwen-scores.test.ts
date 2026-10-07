import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createQwenScores, qwenScoresOff } from './qwen-scores.ts'

type Spawn = NonNullable<Parameters<typeof createQwenScores>[0]['spawn']>

interface Call {
  readonly command: string
  readonly args: readonly string[]
}

function fakeSpawn(
  respond: (child: {
    stdout: PassThrough
    stderr: PassThrough
    emit: (event: string, ...args: unknown[]) => boolean
  }) => void,
) {
  const calls: Call[] = []
  const spawn = ((command: string, args: readonly string[]) => {
    calls.push({ command, args })
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    })
    setImmediate(() => respond(child))
    return child
  }) as unknown as Spawn
  return { spawn, calls }
}

const REPORT = [{ product_id: 'PF_XBTUSD', decisions: { hits: 3, misses: 1 } }]

function succeed(child: {
  stdout: PassThrough
  emit: (event: string, ...args: unknown[]) => boolean
}) {
  child.stdout.end(JSON.stringify(REPORT))
  child.stdout.on('end', () => child.emit('close', 0))
}

const base = {
  python: ['py', '-3'],
  decisionsDbPath: '/d.sqlite',
  verdictsDbPath: '/v.sqlite',
}

describe('Qwen scores', () => {
  it('runs the read-only Python report and returns its products', async () => {
    const { spawn, calls } = fakeSpawn(succeed)
    const scores = createQwenScores({ ...base, spawn, clock: () => 7 })
    expect(await scores.report('PF_XBTUSD')).toEqual({
      status: 'ok',
      generated_at: 7,
      products: REPORT,
    })
    expect(calls).toEqual([
      {
        command: 'py',
        args: [
          '-3',
          '-m',
          'balancita_engine.futures_llm_scores',
          '--decisions-db',
          '/d.sqlite',
          '--verdicts-db',
          '/v.sqlite',
          '--json',
          '--max-rows',
          '200',
          '--products',
          'PF_XBTUSD',
        ],
      },
    ])
  })

  it('caches a result and shares one run between concurrent requests', async () => {
    let now = 0
    const { spawn, calls } = fakeSpawn(succeed)
    const scores = createQwenScores({ ...base, spawn, clock: () => now })
    await Promise.all([scores.report(), scores.report()])
    expect(calls).toHaveLength(1)
    now = 14_999
    await scores.report()
    expect(calls).toHaveLength(1)
    now = 15_000
    await scores.report()
    expect(calls).toHaveLength(2)
  })

  it('rejects a product that is not a PF_ id without running anything', async () => {
    const { spawn, calls } = fakeSpawn(succeed)
    const scores = createQwenScores({ ...base, spawn })
    expect(await scores.report('PF_X; rm')).toEqual({
      status: 'error',
      reason: 'invalid_product',
    })
    expect(calls).toHaveLength(0)
  })

  it('reports a missing database as off and other failures as errors', async () => {
    const missing = fakeSpawn((child) => {
      child.stderr.end(
        'sqlite3.OperationalError: unable to open database file\n',
      )
      child.stderr.on('end', () => child.emit('close', 1))
    })
    expect(
      await createQwenScores({ ...base, spawn: missing.spawn }).report(),
    ).toEqual({ status: 'off', reason: 'decisions_or_verdicts_db_missing' })
    const broken = fakeSpawn((child) => {
      child.stdout.end('not json')
      child.stdout.on('end', () => child.emit('close', 0))
    })
    expect(
      await createQwenScores({ ...base, spawn: broken.spawn }).report(),
    ).toEqual({ status: 'error', reason: 'bad_json' })
  })

  it('times out a stuck run', async () => {
    const { spawn } = fakeSpawn(() => {})
    const scores = createQwenScores({ ...base, spawn, timeoutMs: 10 })
    expect(await scores.report()).toEqual({
      status: 'error',
      reason: 'timeout',
    })
  })

  it('is off when not configured', async () => {
    expect(await qwenScoresOff('decisions_not_configured').report()).toEqual({
      status: 'off',
      reason: 'decisions_not_configured',
    })
  })
})

describe('Qwen scores with the real Python module', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  it('reports off before Q has written its decisions DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-qwen-scores-'))
    dirs.push(dir)
    const scores = createQwenScores({
      python: ['python3'],
      decisionsDbPath: join(dir, 'missing-decisions.sqlite'),
      verdictsDbPath: join(dir, 'missing-verdicts.sqlite'),
      env: {
        ...process.env,
        PYTHONPATH: resolve(import.meta.dirname, '../../../../python'),
      },
    })
    expect(await scores.report('PF_XBTUSD')).toEqual({
      status: 'off',
      reason: 'decisions_or_verdicts_db_missing',
    })
  })
})
