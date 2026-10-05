import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'futures-local-terminal.mjs')

describe('futures local terminal launcher', () => {
  it('documents the standalone loopback command without starting services', () => {
    const result = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'Usage: node scripts/futures-local-terminal.mjs',
    )
    expect(result.stdout).toContain('--output-dir new-path')
  })
})
