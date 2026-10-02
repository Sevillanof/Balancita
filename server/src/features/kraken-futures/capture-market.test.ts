import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'capture-market-test-'))
  directories.push(directory)
  return directory
}

function capture(args: string[], env = process.env) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      'src/features/kraken-futures/capture-market.ts',
      ...args,
    ],
    { cwd: process.cwd(), encoding: 'utf8', env },
  )
}

describe('futures market capture CLI', () => {
  it('rejects unknown arguments before creating the database', () => {
    const database = join(
      tempDirectory(),
      'balancita-futures-market-unsupported.sqlite',
    )
    const result = capture([
      '--mode',
      'mock',
      '--db-path',
      database,
      '--ws-url',
      'ws://127.0.0.1:1',
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Usage:/)
    expect(existsSync(database)).toBe(false)
  })

  it('runs a valid offline mock capture', () => {
    const directory = tempDirectory()
    const database = join(directory, 'balancita-futures-market-mock.sqlite')
    const exported = join(directory, 'balancita-futures-market-export.jsonl')
    const result = capture([
      '--mode',
      'mock',
      '--db-path',
      database,
      '--export',
      exported,
    ])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toMatch(/source=mock/)
    expect(result.stderr).toMatch(/reopened_events=3 candle_revisions=5/)
    expect(result.stdout).toContain('"receivedSequence":1')
    expect(existsSync(database)).toBe(true)
    expect(existsSync(exported)).toBe(true)
    expect(readFileSync(exported, 'utf8')).toBe(result.stdout)
  })

  it('rejects live execution mode environment before opening a database', () => {
    const database = join(
      tempDirectory(),
      'balancita-futures-market-live.sqlite',
    )
    const result = capture(['--mode', 'mock', '--db-path', database], {
      ...process.env,
      EXECUTION_MODE: 'live',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/EXECUTION_MODE/)
    expect(existsSync(database)).toBe(false)
  })
})
