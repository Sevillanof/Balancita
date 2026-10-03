import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runtimeEvidencePath } from './evidence-output.ts'

const repositoryRoot = resolve(import.meta.dirname, '../..')

describe('VT01 browser evidence output', () => {
  it('writes runtime evidence only to the ignored artifact path', () => {
    const outputPath = runtimeEvidencePath(repositoryRoot)
    const relativePath = outputPath.slice(repositoryRoot.length + 1)
    const ignoredPath = execFileSync(
      'git',
      ['check-ignore', '--', relativePath],
      { cwd: repositoryRoot, encoding: 'utf8' },
    ).trim()
    expect(ignoredPath).toBe(relativePath)
    expect(() =>
      execFileSync('git', ['ls-files', '--error-unmatch', relativePath], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      }),
    ).toThrow()
    expect(relativePath).not.toBe('e2e/futures-terminal/evidence.json')
  })
})
