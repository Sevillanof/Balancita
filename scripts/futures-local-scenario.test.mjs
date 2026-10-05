import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'scripts/futures-local-scenario.mjs')
const fixture = join(
  root,
  'server/src/features/paper-futures/fixtures/local-protection.v1.json',
)

describe('futures local scenario CLI', () => {
  it('repeats into fresh databases and refuses reused or invalid targets', () => {
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-cli-test-'))
    try {
      const outputs = ['run-one', 'run-two'].map((name) => join(parent, name))
      const reports = outputs.map((output) => runCli(['--output-dir', output]))
      expect(reports.map((report) => report.fixtureSha256)).toEqual([
        reports[0].fixtureSha256,
        reports[0].fixtureSha256,
      ])
      expect(reports[0].orderIds).toEqual([
        'c27-breakout-perp-v1:c27-breakout-perp-v1:LONG:21540000',
        'local-protection-v1:close:21605200',
      ])
      expect(reports[1].orderIds).toEqual(reports[0].orderIds)
      expect(reports[0].financialChecks.checks).toHaveLength(3)
      expect(
        reports[0].financialChecks.checks.every(({ passed }) => passed),
      ).toBe(true)
      expect(reports[0].financialChecks.fundingLimitation).toContain(
        'non-zero funding accrual, sign, interval coverage and allocation are not verified',
      )
      expect(
        reports.map(
          ({ equityUsd, feesUsd, realizedGrossUsd, finalQuantityBtc }) => ({
            equityUsd,
            feesUsd,
            realizedGrossUsd,
            finalQuantityBtc,
          }),
        ),
      ).toEqual([
        {
          equityUsd: reports[0].equityUsd,
          feesUsd: reports[0].feesUsd,
          realizedGrossUsd: reports[0].realizedGrossUsd,
          finalQuantityBtc: '0',
        },
        {
          equityUsd: reports[0].equityUsd,
          feesUsd: reports[0].feesUsd,
          realizedGrossUsd: reports[0].realizedGrossUsd,
          finalQuantityBtc: '0',
        },
      ])

      const dbPath = join(outputs[0], 'paper-futures.sqlite')
      const beforeReuse = hashFile(dbPath)
      const reused = spawnSync(
        process.execPath,
        [cli, '--output-dir', outputs[0]],
        { cwd: root, encoding: 'utf8' },
      )
      expect(reused.status).not.toBe(0)
      expect(reused.stderr).toContain('Refusing existing scenario output path')
      expect(hashFile(dbPath)).toBe(beforeReuse)

      const invalid = join(parent, 'invalid.json')
      writeFileSync(invalid, '{"mode":"live"}')
      const invalidOutput = join(parent, 'must-not-exist')
      const rejected = spawnSync(
        process.execPath,
        [cli, '--input', invalid, '--output-dir', invalidOutput],
        { cwd: root, encoding: 'utf8' },
      )
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain(
        'Invalid local futures scenario fixture',
      )
      expect(existsSync(invalidOutput)).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

function runCli(extraArgs) {
  const result = spawnSync(
    process.execPath,
    [cli, '--input', fixture, ...extraArgs],
    { cwd: root, encoding: 'utf8' },
  )
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
