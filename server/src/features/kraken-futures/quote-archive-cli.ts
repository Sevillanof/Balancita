import { archiveQuotes } from './quote-archive.ts'

// Usage: pnpm --dir server quotes:archive [--market-db p] [--out p] [--max-days 30] [--max-mb 300]
//        [--min-interval-s 10] [--min-free-gb 5] [--loop-seconds 60]
// Reads the capture's database read-only; writes only its own file. Stops cleanly on SIGINT/SIGTERM.
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const marketDb =
  flag('--market-db') ??
  process.env.FUTURES_MARKET_DB_PATH ??
  './data/dev-live/futures-market.sqlite'
const quotesDb = flag('--out') ?? './data/quotes/quotes.sqlite'
const loop = Number(flag('--loop-seconds') ?? 0)
let stop = false
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => (stop = true))

const pass = () => {
  const result = archiveQuotes({
    marketDb,
    quotesDb,
    maxDays: Number(flag('--max-days') ?? 30),
    maxBytes: Number(flag('--max-mb') ?? 300) * 1_048_576,
    minIntervalMs: Number(flag('--min-interval-s') ?? 10) * 1000,
    minFreeBytes: Number(flag('--min-free-gb') ?? 5) * 1_073_741_824,
  })
  console.log(
    `[quotes:archive] ${new Date().toISOString()} ${JSON.stringify(result)}`,
  )
  if (result.silent.length)
    console.warn(
      `[quotes:archive] WARNING no new quotes for: ${result.silent.join(', ')}`,
    )
  return result
}

for (;;) {
  try {
    const result = pass()
    if (result.stopped) process.exit(2)
  } catch (error) {
    console.error(
      `[quotes:archive] ${error instanceof Error ? error.message : String(error)}`,
    )
    if (!loop) process.exit(1)
  }
  if (!loop || stop) break
  const until = Date.now() + loop * 1000
  while (!stop && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 500))
  if (stop) break
}
