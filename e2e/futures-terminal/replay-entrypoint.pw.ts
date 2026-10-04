import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { availablePort, createRecordedSource } from './replay-source-fixture.ts'

const root = resolve(import.meta.dirname, '../..')
const requireServerDependency = createRequire(join(root, 'server/package.json'))
const WebSocketClient = requireServerDependency('ws') as new (
  url: string,
  options: { origin: string },
) => {
  close(): void
  once(event: string, listener: (value?: unknown) => void): void
  send(value: string): void
}

type ReplayBootstrap = {
  readonly mode: string
  readonly active_run_id: string
  readonly source_manifest: { readonly source_file_hash: string }
}

test('production entrypoint selects isolated REPLAY and shuts down cleanly', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'balancita-vt02-entrypoint-'),
  )
  const sourcePath = join(temporaryDirectory, 'frozen-market.sqlite')
  createRecordedSource(sourcePath)
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  let child: ChildProcess | undefined
  let socket: InstanceType<typeof WebSocketClient> | undefined
  const output: string[] = []
  try {
    child = spawn(
      process.execPath,
      ['--experimental-strip-types', join(root, 'server/src/app/index.ts')],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '',
          HOST: '127.0.0.1',
          PORT: String(port),
          FUTURES_MODE: 'replay',
          FUTURES_DB_PATH: join(temporaryDirectory, 'account.sqlite'),
          FUTURES_REPLAY_SOURCE_DB_PATH: sourcePath,
          GEMINI_SERVER_CORS_ORIGIN: origin,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()))
    const deadline = Date.now() + 15_000
    let bootstrap: ReplayBootstrap | undefined
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`${origin}/api/terminal/bootstrap`)
        if (response.ok) {
          bootstrap = (await response.json()) as ReplayBootstrap
          break
        }
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
    }
    expect(bootstrap?.mode, output.join('')).toBe('replay')
    expect(bootstrap?.source_manifest?.source_file_hash).toBe(
      createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex'),
    )
    socket = new WebSocketClient(
      `${origin.replace('http:', 'ws:')}/api/terminal/stream`,
      { origin },
    )
    await new Promise<void>((resolvePromise, reject) => {
      socket!.once('open', resolvePromise)
      socket!.once('error', () =>
        reject(new Error('Entrypoint WebSocket failed.')),
      )
    })
    const snapshot = await new Promise<{ type: string; run_id: string }>(
      (resolvePromise, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Entrypoint stream snapshot timed out.')),
          5000,
        )
        socket!.once('message', (raw) => {
          clearTimeout(timeout)
          resolvePromise(
            JSON.parse(String(raw)) as { type: string; run_id: string },
          )
        })
        socket!.send(
          JSON.stringify({
            schema_version: 1,
            type: 'subscribe',
            run_id: bootstrap!.active_run_id,
          }),
        )
      },
    )
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot.run_id).toBe(bootstrap.active_run_id)
  } finally {
    socket?.close()
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((resolvePromise) => {
        child!.once('exit', () => resolvePromise())
        setTimeout(resolvePromise, 5000)
      })
    }
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})
