import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerConfig } from '../../platform/config.ts'

/** Run the same CLI as the operator, off the HTTP event loop. Never writes the live DB. */
export function refreshSimulations(config: ServerConfig): Promise<void> {
  const serverRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const cli = fileURLToPath(new URL('./simulations-cli.ts', import.meta.url))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        '--latest-contiguous',
        '--horizon',
        '15m,1h',
        '--market-db',
        resolve(serverRoot, config.marketDbPath),
        '--report',
        resolve(serverRoot, config.simulationsReportPath),
      ],
      { cwd: serverRoot, stdio: 'ignore' },
    )
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else
        reject(
          new Error(
            'No contiguous Kraken window is ready for simulation. Check market gaps or run simulations:run with an explicit clean --since/--until range.',
          ),
        )
    })
  })
}
