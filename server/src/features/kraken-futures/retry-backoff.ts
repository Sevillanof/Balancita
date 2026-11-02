/**
 * Runs `task` and, if it throws, tries again after 1 s, 2 s, 4 s... (capped at
 * `maxDelayMs`), up to `attempts` tries in total. The last error is rethrown.
 * Used for the capture's own start-up queries to Kraken, which fail right after
 * the machine wakes up while the network is still coming back.
 */
export async function retryWithBackoff<T>(
  task: () => Promise<T>,
  options: {
    readonly attempts?: number
    readonly baseMs?: number
    readonly maxDelayMs?: number
    readonly sleep?: (ms: number) => Promise<void>
    readonly onRetry?: (
      attempt: number,
      delayMs: number,
      error: unknown,
    ) => void
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5)
  const base = options.baseMs ?? 1_000
  const cap = options.maxDelayMs ?? 30_000
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= attempts) throw error
      const delay = Math.min(cap, base * 2 ** (attempt - 1))
      options.onRetry?.(attempt, delay, error)
      await sleep(delay)
    }
  }
}
