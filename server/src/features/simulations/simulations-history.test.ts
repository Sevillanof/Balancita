import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listSimulationReportHistory,
  readSimulationReportHistoryDetail,
  simulationArchivePath,
  simulationReportId,
  writeSimulationReportArchive,
} from './simulations-history.ts'

const dirs: string[] = []
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-history-'))
  dirs.push(dir)
  const report = join(dir, 'report.json')
  mkdirSync(dir, { recursive: true })
  return { dir, report }
}
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
)

describe('simulation report history', () => {
  it('lists complete-content identities newest first with a bounded limit and validated detail IDs', () => {
    const { report } = setup()
    const a = {
      generatedAt: 1,
      datasetHash: 'same',
      manifestHash: 'same',
      reports: [],
      request: { seed: 1 },
    }
    const b = { ...a, generatedAt: 2, request: { seed: 2 } }
    writeFileSync(simulationArchivePath(report, a), JSON.stringify(a))
    writeFileSync(simulationArchivePath(report, b), JSON.stringify(b))
    expect(
      listSimulationReportHistory(report, 1).map((entry) => entry.generatedAt),
    ).toEqual([2])
    const id = listSimulationReportHistory(report)[0]!.id
    expect(readSimulationReportHistoryDetail(report, id)).toBe(
      JSON.stringify(b),
    )
    expect(
      readSimulationReportHistoryDetail(report, '../report'),
    ).toBeUndefined()
    expect(
      readSimulationReportHistoryDetail(report, 'f'.repeat(64)),
    ).toBeUndefined()
  })

  it('includes readable legacy archives without rewriting them', () => {
    const { report } = setup()
    const legacy = join(
      report.split('/').slice(0, -1).join('/'),
      'report.json.legacyhash.dataset.json',
    )
    const body = JSON.stringify({
      generatedAt: 3,
      datasetHash: 'd',
      manifestHash: 'm',
      reports: [],
    })
    writeFileSync(legacy, body)
    const entry = listSimulationReportHistory(report)[0]!
    expect(entry.generatedAt).toBe(3)
    expect(entry.id).toMatch(/^[0-9a-f]{64}$/)
    expect(readSimulationReportHistoryDetail(report, entry.id)).toBe(body)
  })

  it('includes and resolves the current latest report alongside archives', () => {
    const { report } = setup()
    const body = JSON.stringify({
      generatedAt: 4,
      datasetHash: 'latest',
      manifestHash: 'm',
      reports: [],
    })
    writeFileSync(report, body)
    const entry = listSimulationReportHistory(report)[0]!
    expect(entry.generatedAt).toBe(4)
    expect(readSimulationReportHistoryDetail(report, entry.id)).toBe(body)
  })

  it('writes a new archive atomically and never replaces an existing identity', () => {
    const { report } = setup()
    const entry = {
      generatedAt: 5,
      datasetHash: 'd',
      manifestHash: 'm',
      reports: [],
    }
    const first = writeSimulationReportArchive(report, entry)
    const second = writeSimulationReportArchive(report, {
      ...entry,
      generatedAt: 6,
    })
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(writeSimulationReportArchive(report, entry)).toBe(false)
    expect(
      JSON.parse(
        readSimulationReportHistoryDetail(report, simulationReportId(entry))!,
      ),
    ).toEqual(entry)
  })
})
