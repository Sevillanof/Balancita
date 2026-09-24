import { createHash, randomUUID } from 'node:crypto'
import {
  linkSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const SIMULATIONS_HISTORY_LIMIT = 50
export interface SimulationHistoryEntry {
  readonly id: string
  readonly generatedAt: number
  readonly datasetHash: string
  readonly manifestHash: string
  readonly sample?: { readonly stage: string; readonly seed: number }
  readonly window?: { readonly since: number; readonly until: number }
}

export function simulationReportId(report: unknown): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex')
}

export function simulationArchivePath(
  reportPath: string,
  report: unknown,
): string {
  return `${reportPath}.${simulationReportId(report)}.json`
}

export function writeSimulationReportArchive(
  reportPath: string,
  report: unknown,
): boolean {
  const archivePath = simulationArchivePath(reportPath, report)
  const temporaryPath = `${archivePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  })
  try {
    linkSync(temporaryPath, archivePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    unlinkSync(temporaryPath)
  }
}

export function listSimulationReportHistory(
  reportPath: string,
  limit = SIMULATIONS_HISTORY_LIMIT,
): SimulationHistoryEntry[] {
  const safeLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, SIMULATIONS_HISTORY_LIMIT))
    : SIMULATIONS_HISTORY_LIMIT
  const prefix = `${basename(reportPath)}.`
  let names: string[]
  try {
    names = readdirSync(dirname(reportPath)).filter(
      (name) => name.startsWith(prefix) && name.endsWith('.json'),
    )
  } catch {
    return []
  }
  const candidates = [
    reportPath,
    ...names.map((name) => join(dirname(reportPath), name)),
  ]
  const entries = candidates.flatMap((path) => {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof value !== 'object' || value === null) return []
      const report = value as Record<string, unknown>
      if (
        typeof report.generatedAt !== 'number' ||
        typeof report.datasetHash !== 'string' ||
        typeof report.manifestHash !== 'string'
      )
        return []
      const sample =
        typeof report.sample === 'object' && report.sample !== null
          ? (report.sample as Record<string, unknown>)
          : undefined
      const window =
        typeof report.window === 'object' && report.window !== null
          ? (report.window as Record<string, unknown>)
          : undefined
      return [
        {
          id: simulationReportId(report),
          generatedAt: report.generatedAt,
          datasetHash: report.datasetHash,
          manifestHash: report.manifestHash,
          ...(sample &&
          typeof sample.stage === 'string' &&
          typeof sample.seed === 'number'
            ? { sample: { stage: sample.stage, seed: sample.seed } }
            : {}),
          ...(window &&
          typeof window.since === 'number' &&
          typeof window.until === 'number'
            ? { window: { since: window.since, until: window.until } }
            : {}),
        },
      ]
    } catch {
      return []
    }
  })
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    .sort((a, b) => b.generatedAt - a.generatedAt || b.id.localeCompare(a.id))
    .slice(0, safeLimit)
}

export function readSimulationReportHistoryDetail(
  reportPath: string,
  id: string,
): string | undefined {
  if (!/^[0-9a-f]{64}$/.test(id)) return undefined
  const candidates = [reportPath]
  try {
    const prefix = `${basename(reportPath)}.`
    candidates.push(
      ...readdirSync(dirname(reportPath))
        .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
        .map((name) => join(dirname(reportPath), name)),
    )
  } catch {
    return undefined
  }
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf8')
      if (simulationReportId(JSON.parse(raw)) === id) return raw
    } catch {
      continue
    }
  }
  return undefined
}
