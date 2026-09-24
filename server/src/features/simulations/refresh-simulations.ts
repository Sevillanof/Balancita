import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerConfig } from '../../platform/config.ts'

/** Run the same CLI as the operator, off the HTTP event loop. Never writes the live DB. */
export function refreshSimulations(
  config: ServerConfig,
  sample?: { readonly stage: 'smoke' | 'confirm'; readonly seed: number },
): Promise<void> {
  const serverRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const cli = fileURLToPath(new URL('./simulations-cli.ts', import.meta.url))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        ...(sample === undefined ? ['--latest-contiguous'] : []),
        '--horizon',
        '15m,1h',
        ...(sample === undefined
          ? []
          : ['--stage', sample.stage, '--seed', String(sample.seed)]),
        '--market-db',
        resolve(serverRoot, config.marketDbPath),
        '--report',
        resolve(serverRoot, config.simulationsReportPath),
      ],
      { cwd: serverRoot, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 4_096)
        stderr += String(chunk).slice(0, 4_096 - stderr.length)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(stderr.slice(0, 4_096)))
    })
  })
}
