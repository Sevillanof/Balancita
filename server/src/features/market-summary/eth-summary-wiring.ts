import {
  createEthMinuteSummary,
  type EthMinuteSummaryOptions,
} from './eth-minute-summary.ts'

export interface EthSummaryWiringOptions {
  /** Path of the capture database. */
  readonly dbPath: string
  /** Same gate the retention uses: no summary run while writes are not allowed or a backup is running. */
  readonly canRun: () => boolean
  readonly log: (line: string) => void
  /** Test seam: the summary factory. */
  readonly create?: typeof createEthMinuteSummary
  readonly clock?: EthMinuteSummaryOptions['clock']
}

/**
 * Opens the per-minute ETH summary next to the capture; `start()` begins its
 * runs (call it after the capture started) and `stop()` closes it. The summary
 * is an extra: failing to open it, a failing run or a failing stop is logged
 * (once per distinct message) and never reaches the capture.
 */
export function wireEthMinuteSummary(options: EthSummaryWiringOptions): {
  readonly running: boolean
  start(): void
  stop(): void
} {
  let lastError: string | undefined
  const fail = (what: string, error: unknown): void => {
    const text = `eth minute summary ${what}: ${error instanceof Error ? error.message : String(error)}`
    if (text === lastError) return
    lastError = text
    options.log(text)
  }
  let summary: ReturnType<typeof createEthMinuteSummary> | undefined
  try {
    summary = (options.create ?? createEthMinuteSummary)({
      dbPath: options.dbPath,
      canRun: options.canRun,
      onError: (error) => fail('failed', error),
      ...(options.clock ? { clock: options.clock } : {}),
    })
  } catch (error) {
    fail('not started', error)
    summary = undefined
  }
  return {
    get running() {
      return summary !== undefined
    },
    start() {
      try {
        summary?.start()
      } catch (error) {
        fail('not started', error)
      }
    },
    stop() {
      const current = summary
      summary = undefined
      if (!current) return
      try {
        current.stop()
      } catch (error) {
        fail('stop failed', error)
      }
    },
  }
}
