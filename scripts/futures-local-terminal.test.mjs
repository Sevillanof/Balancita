import { spawn, spawnSync } from 'node:child_process'
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

  it('serves only the MOCK API with --api-only (no UI server)', async () => {
    const apiPort = 18_000 + Math.floor(Math.random() * 1_000)
    const child = spawn(
      process.execPath,
      [script, '--api-only', '--api-port', String(apiPort)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))
    try {
      await new Promise((resolveReady, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`not ready: ${output}`)),
          25_000,
        )
        const poll = setInterval(() => {
          if (output.includes(`API http://127.0.0.1:${apiPort}`)) {
            clearTimeout(timer)
            clearInterval(poll)
            resolveReady(undefined)
          }
        }, 100)
        child.once('exit', () => reject(new Error(`exited: ${output}`)))
      })
      const response = await fetch(
        `http://127.0.0.1:${apiPort}/api/terminal/bootstrap`,
      )
      expect(response.status).toBe(200)
      expect((await response.json()).mode).toBe('mock')
      expect(output).not.toContain('Terminal http://')
    } finally {
      child.kill('SIGTERM')
      await new Promise((resolveExit) => child.once('exit', resolveExit))
    }
  }, 40_000)
})
