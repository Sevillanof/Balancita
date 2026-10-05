import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FuturesCommandRunner } from './futures-command-runner.js'
import { FuturesStore } from './futures-store.js'
import {
  buildLocalScenarioSnapshot,
  recoverLocalScenarioProgress,
  runLocalFuturesScenario,
  type LocalScenario,
} from './futures-local-scenario.js'

const scenarioPath = resolve(
  process.cwd(),
  'src/features/paper-futures/fixtures/local-protection.v1.json',
)
const loadFixture = () =>
  JSON.parse(readFileSync(scenarioPath, 'utf8')) as LocalScenario
// Test-only loose view over durable JSON projections.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>
const asRecord = (value: unknown) => value as Rec

/** Deterministic durable projection of a run: everything but wall-clock fields. */
function canonicalRun(databasePath: string, runId: string) {
  const store = new FuturesStore(databasePath)
  try {
    const exported = asRecord(store.exportRun(runId))
    const outputs = (exported.runtime_outputs as Rec[]) ?? []
    const last = outputs.at(-1)!
    return {
      verified: store.verifyRun(runId),
      pending: store.loadPendingCommands().length,
      stateVersion: asRecord(store.getRunProjection(runId)).state_version,
      headHash: exported.head_hash,
      events: exported.events,
      outputs,
      summary: {
        orders: Object.fromEntries(
          Object.entries(
            asRecord(
              asRecord(asRecord(store.getRunProjection(runId)).checkpoint)
                .execution_checkpoint,
            ).orders,
          ).map(([id, order]) => [id, order]),
        ),
        fills: outputs.flatMap((output) =>
          (output.fills as Rec[]).map((fill) => ({
            id: fill.fill_id,
            order: fill.order_id,
            quantity: fill.quantity_btc,
            price: fill.price_usd_per_btc,
            fee: fill.fee_usd,
          })),
        ),
        analyses: outputs.map(
          (output) => asRecord(output.analysis).analysis_id,
        ),
        position: last.position,
        ledger: last.ledger,
      },
    }
  } finally {
    store.close()
  }
}

async function continuousRun(parent: string) {
  const report = await runLocalFuturesScenario(loadFixture(), {
    outputDirectory: resolve(parent, 'continuous'),
  })
  return canonicalRun(String(report.databasePath), loadFixture().run_id)
}

/**
 * Runs the scenario in a child process that is SIGKILLed at a precise durable
 * point, so recovery is proven against a truly abrupt stop (no graceful close).
 */
async function killChildAt(
  directory: string,
  point: { committed: number } | { acceptedUncommitted: number },
) {
  const source = `
    const { runLocalFuturesScenario } = await import(${JSON.stringify(
      resolve(
        process.cwd(),
        'src/features/paper-futures/futures-local-scenario.ts',
      ),
    )})
    const { FuturesStore } = await import(${JSON.stringify(
      resolve(process.cwd(), 'src/features/paper-futures/futures-store.ts'),
    )})
    const { FuturesCommandRunner } = await import(${JSON.stringify(
      resolve(
        process.cwd(),
        'src/features/paper-futures/futures-command-runner.ts',
      ),
    )})
    import('node:fs').then(async ({ readFileSync, mkdirSync }) => {
      const fixture = JSON.parse(readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'))
      mkdirSync(${JSON.stringify(directory)}, { recursive: true })
      const store = new FuturesStore(${JSON.stringify(directory + '/paper-futures.sqlite')})
      const runner = new FuturesCommandRunner(store)
      const point = ${JSON.stringify(point)}
      if ('acceptedUncommitted' in point) {
        // Hold only the target stage's worker commit: it stays durably
        // accepted (queued) and is never committed before the SIGKILL.
        const commit = runner.commit.bind(runner)
        runner.commit = (result, request) => {
          if (!request.work_id.includes('-' + (point.acceptedUncommitted + 1) + '-'))
            return commit(result, request)
          process.stdout.write('KILL_POINT ')
          return new Promise(() => {})
        }
      }
      await runLocalFuturesScenario(fixture, {
        outputDirectory: ${JSON.stringify(directory)},
        store,
        runner,
        interactive: true,
        onStage: async (stage) => {
          if (stage.kind === 'committed' && 'committed' in point && stage.index === point.committed) {
            process.stdout.write('KILL_POINT ')
            await new Promise(() => {})
          }
        },
      })
    })
  `
  await new Promise<void>((resolveKill, rejectKill) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', source],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectKill(new Error(`Kill point not reached: ${output}`))
    }, 90_000)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (output.includes('KILL_POINT')) {
        clearTimeout(timer)
        child.once('exit', () => resolveKill())
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.once('error', rejectKill)
  })
}

async function resumeScenario(directory: string) {
  const fixture = loadFixture()
  const store = new FuturesStore(resolve(directory, 'paper-futures.sqlite'))
  const runner = new FuturesCommandRunner(store)
  try {
    const progress = recoverLocalScenarioProgress(fixture, store)
    await runLocalFuturesScenario(fixture, {
      outputDirectory: directory,
      store,
      runner,
      interactive: true,
      adoptExistingRun: true,
      startIndex: progress.nextStageIndex,
    })
    return progress
  } finally {
    await runner.close()
    store.close()
  }
}

describe('local futures scenario', () => {
  it('awaits presentation hooks only after actual committed receipts', async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'src/features/paper-futures/fixtures/local-protection.v1.json',
        ),
        'utf8',
      ),
    )
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-hook-test-'))
    const stages: Array<{ kind: string; index?: number; receipt?: string }> = []
    try {
      await runLocalFuturesScenario(fixture, {
        outputDirectory: resolve(parent, 'fresh-output'),
        onStage: async (stage) => {
          stages.push({
            kind: stage.kind,
            index: stage.index,
            receipt: String(stage.receipt?.status ?? ''),
          })
          if (stage.kind === 'committed') {
            expect(stage.receipt?.status).toBe('committed')
            expect(stage.output).toBeTruthy()
            expect(stage.marketSnapshot).toBeTruthy()
          }
        },
      })
      expect(stages.map(({ kind }) => kind)).toEqual([
        'started',
        'committed',
        'committed',
        'committed',
        'committed',
        'committed',
        'completed',
      ])
      expect(stages.slice(1, 6).map(({ receipt }) => receipt)).toEqual(
        Array(5).fill('committed'),
      )
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('runs the owned protection fixture through the real worker and durable store', async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'src/features/paper-futures/fixtures/local-protection.v1.json',
        ),
        'utf8',
      ),
    )
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-module-test-'))
    try {
      const report = await runLocalFuturesScenario(fixture, {
        outputDirectory: resolve(parent, 'fresh-output'),
      })

      expect(report.mode).toBe('LOCAL_SIMULATION')
      expect(report.finalQuantityBtc).toBe('0')
      expect(report.orderIds).toEqual([
        'c27-breakout-perp-v1:c27-breakout-perp-v1:LONG:21540000',
        'local-protection-v1:close:21605200',
      ])
      expect(report.entryOrderId).toBeTruthy()
      expect(report.entryEligibleAtMs).toBe(21_605_100)
      expect(report.partialFillQuantityBtc).toBe('0.005')
      expect(report.partialFillAtMs).toBe(21_605_100)
      expect(report.protectiveCloseQuantityBtc).toBe('0.005')
      expect(report.protectiveCloseAtMs).toBe(21_605_300)
      expect(report.verified).toBe(true)
      expect(report.financialChecks.checks).toHaveLength(3)
      expect(
        report.financialChecks.checks.map((check) => check.expected.equityUsd),
      ).toEqual(['10000', '9999.7474975', '9999.21014'])
      expect(report.financialChecks.fundingLimitation).toContain(
        'Funding is zero in this local scenario',
      )
      expect(report.committedAcknowledgements).toBe(5)
      expect(report.pendingCommands).toBe(0)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('requires the durable protective stop unless the run is interactive', () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'src/features/paper-futures/fixtures/local-protection.v1.json',
        ),
        'utf8',
      ),
    ) as LocalScenario
    expect(() => buildLocalScenarioSnapshot(fixture, 3)).toThrow(
      'Real strategy did not establish protective stop.',
    )
    const tolerated = buildLocalScenarioSnapshot(fixture, 3, {
      tolerateMissingProtection: true,
    })
    const book = (tolerated.events as Record<string, unknown>[]).find(
      (event) => event.type === 'book_snapshot',
    )
    expect(book?.bids).toEqual([{ price_usd: '100000', quantity_btc: '1' }])
  })
})

describe('local futures scenario recovery (Step 7)', () => {
  it('recovers an interrupted MOCK run with an open position and matches the continuous run', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-recovery-'))
    try {
      const continuous = await continuousRun(parent)
      const interrupted = await runLocalFuturesScenario(loadFixture(), {
        outputDirectory: resolve(parent, 'recovered'),
        interactive: true,
        stopAfterIndex: 2,
      })
      expect(interrupted).toMatchObject({
        interrupted: true,
        committedStages: 3,
      })
      const midway = canonicalRun(
        resolve(parent, 'recovered/paper-futures.sqlite'),
        loadFixture().run_id,
      )
      expect(midway.summary.position).toMatchObject({
        side: 'long',
        quantity_btc: '0.005',
      })
      expect(midway.stateVersion).toBe(3)
      expect(midway.pending).toBe(0)

      const progress = await resumeScenario(resolve(parent, 'recovered'))
      expect(progress).toMatchObject({ nextStageIndex: 3, committedStages: 3 })
      const recovered = canonicalRun(
        resolve(parent, 'recovered/paper-futures.sqlite'),
        loadFixture().run_id,
      )
      expect(recovered.summary.position).toMatchObject({ quantity_btc: '0' })
      expect(recovered.summary.ledger).toMatchObject({
        equity_usd: '9999.21014',
        fees_usd: '0.49986',
        realized_gross_usd: '-0.29',
      })
      expect(recovered.summary.fills).toHaveLength(2)
      expect(recovered.summary.analyses).toHaveLength(5)
      expect(recovered.summary).toEqual(continuous.summary)
      expect(recovered.outputs).toEqual(continuous.outputs)
      expect(recovered.events).toEqual(continuous.events)
      expect(recovered.headHash).toEqual(continuous.headHash)
      expect(recovered.verified).toBe(true)
      expect(recovered.pending).toBe(0)
      expect(recovered.stateVersion).toBe(5)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('recovers after SIGKILL at a committed boundary with the position open', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-sigkill-'))
    try {
      const continuous = await continuousRun(parent)
      const directory = resolve(parent, 'killed')
      await killChildAt(directory, { committed: 2 })
      const progress = await resumeScenario(directory)
      expect(progress.nextStageIndex).toBe(3)
      const recovered = canonicalRun(
        resolve(directory, 'paper-futures.sqlite'),
        loadFixture().run_id,
      )
      expect(recovered.summary).toEqual(continuous.summary)
      expect(recovered.outputs).toEqual(continuous.outputs)
      expect(recovered.verified).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('recovers a stage accepted but not committed at SIGKILL without duplicate effects', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-inflight-'))
    try {
      const continuous = await continuousRun(parent)
      const directory = resolve(parent, 'killed')
      await killChildAt(directory, { acceptedUncommitted: 3 })
      const store = new FuturesStore(resolve(directory, 'paper-futures.sqlite'))
      try {
        // Position is open and the stop-crossing stage is accepted, uncommitted.
        expect(store.loadPendingCommands()).toHaveLength(1)
        expect(
          store.getAppliedReceipt(
            `${loadFixture().run_id}-4-protective-stop-crossing`,
          ),
        ).toBeUndefined()
        expect(
          asRecord(store.getRunProjection(loadFixture().run_id)).state_version,
        ).toBe(3)
      } finally {
        store.close()
      }
      const progress = await resumeScenario(directory)
      expect(progress.nextStageIndex).toBe(3)
      const recovered = canonicalRun(
        resolve(directory, 'paper-futures.sqlite'),
        loadFixture().run_id,
      )
      expect(recovered.summary).toEqual(continuous.summary)
      expect(recovered.outputs).toEqual(continuous.outputs)
      expect(recovered.summary.fills).toHaveLength(2)
      expect(new Set(recovered.summary.fills.map((fill) => fill.id)).size).toBe(
        2,
      )
      expect(recovered.pending).toBe(0)
      expect(recovered.verified).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('derives no progress for a run with no committed stage', () => {
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-progress-'))
    const store = new FuturesStore(resolve(parent, 'paper-futures.sqlite'))
    try {
      expect(recoverLocalScenarioProgress(loadFixture(), store)).toMatchObject({
        nextStageIndex: 0,
        committedStages: 0,
      })
    } finally {
      store.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
