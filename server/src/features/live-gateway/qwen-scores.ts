import { spawn as nodeSpawn } from 'node:child_process'

/**
 * Hits, misses and returns of Qwen's decisions for the gateway. The report is
 * computed by `python -m balancita_engine.futures_llm_scores`, read-only over
 * Q's decisions DB and C's verdicts DB, so the gateway still writes nothing.
 * One run at a time; a result is reused for `cacheMs`.
 */
export interface QwenScoresOptions {
  /** Python executable and its prefix args (e.g. `['py', '-3']`). */
  readonly python: readonly string[]
  readonly decisionsDbPath: string
  readonly verdictsDbPath: string
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly cacheMs?: number
  readonly maxRows?: number
  readonly clock?: () => number
  readonly spawn?: typeof nodeSpawn
}

export type QwenScoresResponse =
  | {
      readonly status: 'ok'
      readonly generated_at: number
      readonly products: readonly unknown[]
    }
  | { readonly status: 'off'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string }

const PRODUCT = /^PF_[A-Z0-9]{2,16}$/
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export interface QwenScores {
  report(product?: string): Promise<QwenScoresResponse>
}

export function qwenScoresOff(reason: string): QwenScores {
  return { report: async () => ({ status: 'off', reason }) }
}

export function createQwenScores(options: QwenScoresOptions): QwenScores {
  const spawn = options.spawn ?? nodeSpawn
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? 15_000
  const cache = new Map<string, { at: number; value: QwenScoresResponse }>()
  const running = new Map<string, Promise<QwenScoresResponse>>()

  const run = (product: string) =>
    new Promise<QwenScoresResponse>((resolve) => {
      const [command, ...prefix] = options.python
      const args = [
        ...prefix,
        '-m',
        'balancita_engine.futures_llm_scores',
        '--decisions-db',
        options.decisionsDbPath,
        '--verdicts-db',
        options.verdictsDbPath,
        '--json',
        '--max-rows',
        String(options.maxRows ?? 200),
        ...(product ? ['--products', product] : []),
      ]
      let stdout = ''
      let stderr = ''
      let done = false
      const finish = (value: QwenScoresResponse) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const child = spawn(command as string, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ status: 'error', reason: 'timeout' })
      }, options.timeoutMs ?? 20_000)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
        if (stdout.length > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL')
          finish({ status: 'error', reason: 'output_too_large' })
        }
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-2_000)
      })
      child.on('error', (error) =>
        finish({ status: 'error', reason: `spawn_failed: ${error.message}` }),
      )
      child.on('close', (code) => {
        if (code !== 0) {
          // Q or C has not created its DB yet: nothing to score, not a fault.
          const missing = /unable to open database file/.test(stderr)
          finish(
            missing
              ? { status: 'off', reason: 'decisions_or_verdicts_db_missing' }
              : {
                  status: 'error',
                  reason: `exit_${code}: ${stderr.trim().split('\n').pop() ?? ''}`,
                },
          )
          return
        }
        try {
          const products = JSON.parse(stdout) as unknown[]
          finish({ status: 'ok', generated_at: clock(), products })
        } catch {
          finish({ status: 'error', reason: 'bad_json' })
        }
      })
    })

  return {
    async report(product = '') {
      if (product && !PRODUCT.test(product))
        return { status: 'error', reason: 'invalid_product' }
      const cached = cache.get(product)
      if (cached && clock() - cached.at < cacheMs) return cached.value
      const pending = running.get(product)
      if (pending) return pending
      const promise = run(product).then((value) => {
        cache.set(product, { at: clock(), value })
        running.delete(product)
        return value
      })
      running.set(product, promise)
      return promise
    },
  }
}
