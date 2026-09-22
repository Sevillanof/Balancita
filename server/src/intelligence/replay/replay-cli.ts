/**
 * CLI entry for the minimal deterministic replay runner.
 *
 * Reads already-collected Kraken BTC-EUR observations from the live market
 * database (strictly read-only) and replays the deterministic baseline for
 * one run per horizon into isolated replay stores.
 *
 * Usage (from server/):
 *   node --experimental-strip-types src/intelligence/replay/replay-cli.ts \
 *     [--horizon 15m,1h,4h,24h] [--since <epochMs>] [--until <epochMs>] \
 *     [--market-db data/market.sqlite] [--dataset-db data/replay-datasets.sqlite] \
 *     [--runs-db data/replay-runs.sqlite] [--ledger-db data/replay-ledger.sqlite] \
 *     [--out <file>]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ForecastHorizon, TimestampMs } from '../contracts.ts'
import { REPLAY_RUNNER_HORIZONS, runReplayFromLiveDb } from './replay-runner.ts'

const ALL_HORIZONS: readonly ForecastHorizon[] = REPLAY_RUNNER_HORIZONS

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function parseHorizons(raw: string | undefined): ForecastHorizon[] {
  if (raw === undefined) return [...ALL_HORIZONS]
  const horizons = raw
    .split(',')
    .map((entry) => entry.trim()) as ForecastHorizon[]
  for (const horizon of horizons) {
    if (!ALL_HORIZONS.includes(horizon)) {
      throw new Error(
        `Unsupported horizon "${horizon}". Expected one of ${ALL_HORIZONS.join(', ')}.`,
      )
    }
  }
  if (horizons.length === 0)
    throw new Error('At least one horizon is required.')
  return [...new Set(horizons)]
}

function parseTimestamp(
  raw: string | undefined,
  name: string,
): TimestampMs | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative integer epoch in milliseconds.`,
    )
  }
  return value as TimestampMs
}

function resolveFrom(
  cwd: string,
  raw: string | undefined,
  fallback: string,
): string {
  return resolve(cwd, raw ?? fallback)
}

export function runCli(argv: readonly string[], cwd: string): string {
  const horizons = parseHorizons(flagValue(argv, '--horizon'))
  const result = runReplayFromLiveDb({
    marketDbPath: resolveFrom(
      cwd,
      flagValue(argv, '--market-db'),
      'data/market.sqlite',
    ),
    datasetDbPath: resolveFrom(
      cwd,
      flagValue(argv, '--dataset-db'),
      'data/replay-datasets.sqlite',
    ),
    runsDbPath: resolveFrom(
      cwd,
      flagValue(argv, '--runs-db'),
      'data/replay-runs.sqlite',
    ),
    ledgerDbPath: resolveFrom(
      cwd,
      flagValue(argv, '--ledger-db'),
      'data/replay-ledger.sqlite',
    ),
    horizons,
    ...(parseTimestamp(flagValue(argv, '--since'), '--since') === undefined
      ? {}
      : { since: parseTimestamp(flagValue(argv, '--since'), '--since')! }),
    ...(parseTimestamp(flagValue(argv, '--until'), '--until') === undefined
      ? {}
      : { until: parseTimestamp(flagValue(argv, '--until'), '--until')! }),
  })
  const output = `${JSON.stringify(result, null, 2)}\n`
  const out = flagValue(argv, '--out')
  if (out !== undefined) {
    const outPath = resolve(cwd, out)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, output)
  }
  return output
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('replay-cli.ts')

if (invokedDirectly) {
  try {
    const output = runCli(process.argv.slice(2), process.cwd())
    if (!process.argv.includes('--out')) process.stdout.write(output)
    else process.stdout.write(`Replay complete. Summary written.\n`)
  } catch (error) {
    process.stderr.write(
      `replay:run failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
