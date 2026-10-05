import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runLocalFuturesScenario } from './futures-local-scenario.js'

describe('local futures scenario', () => {
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
      expect(report.committedAcknowledgements).toBe(5)
      expect(report.pendingCommands).toBe(0)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
