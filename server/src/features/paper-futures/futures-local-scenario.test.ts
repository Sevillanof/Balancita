import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLocalScenarioSnapshot,
  runLocalFuturesScenario,
  type LocalScenario,
} from './futures-local-scenario.js'

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
