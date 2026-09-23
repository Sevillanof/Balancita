/**
 * CLI entry for the honest strategy-comparison harness.
 *
 * Reads already-collected Kraken BTC-EUR observations from the live market
 * database (strictly read-only) and replays every pre-registered manifest
 * candidate into isolated simulation stores. Writes the comparison report
 * (report-all table, baseline trio, once-validated winner) to a JSON file
 * served read-only by `GET /api/intelligence/simulations`.
 *
 * Usage (from server/):
 *   pnpm simulations:run \
 *     [--horizon 15m] [--selection-pct 0.7] [--since <epochMs>] [--until <epochMs>] \
 *     [--cash 10000] [--entry 0.55] [--exit 0.45] \
 *     [--market-db data/market.sqlite] \
 *     [--dataset-db data/simulations-datasets.sqlite] \
 *     [--runs-db data/simulations-runs.sqlite] \
 *     [--ledger-db data/simulations-ledger.sqlite] \
 *     [--report data/simulations-report.json] [--out <file>]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ForecastHorizon, TimestampMs } from '../../domain/contracts.ts'
import {
  runSimulationsFromLiveDb,
  SIMULATIONS_DEFAULT_HORIZON,
  SIMULATIONS_DEFAULT_SELECTION_PCT,
} from './simulations-runner.ts'

const ALL_HORIZONS: readonly ForecastHorizon[] = ['15m', '1h', '4h', '24h']

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function parseHorizons(raw: string | undefined): ForecastHorizon[] {
  if (raw === undefined) return [SIMULATIONS_DEFAULT_HORIZON]
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

function parseCash(raw: string | undefined): number {
  if (raw === undefined) return 10_000
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('--cash must be a finite positive amount in EUR.')
  }
  return value
}

function parseThreshold(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(
      `${name} must be a finite fraction strictly between 0 and 1.`,
    )
  }
  return value
}

function parseSelectionPct(raw: string | undefined): number {
  if (raw === undefined) return SIMULATIONS_DEFAULT_SELECTION_PCT
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(
      '--selection-pct must be a finite fraction strictly between 0 and 1.',
    )
  }
  return value
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

export function runSimulationsCli(
  argv: readonly string[],
  cwd: string,
): string {
  const horizons = parseHorizons(flagValue(argv, '--horizon'))
  const result = runSimulationsFromLiveDb({
    marketDbPath: resolveFrom(
      cwd,
      flagValue(argv, '--market-db'),
      'data/market.sqlite',
    ),
    datasetDbPath: resolveFrom(
      cwd,
      flagValue(argv, '--dataset-db'),
      'data/simulations-datasets.sqlite',
    ),
    runsDbPath: resolveFrom(
      cwd,
      flagValue(argv, '--runs-db'),
      'data/simulations-runs.sqlite',
    ),
    ledgerDbPath: resolveFrom(
      cwd,
      flagValue(argv, '--ledger-db'),
      'data/simulations-ledger.sqlite',
    ),
    reportPath: resolveFrom(
      cwd,
      flagValue(argv, '--report'),
      'data/simulations-report.json',
    ),
    horizons,
    latestContiguous: argv.includes('--latest-contiguous'),
    selectionPct: parseSelectionPct(flagValue(argv, '--selection-pct')),
    startingCash: parseCash(flagValue(argv, '--cash')),
    ...(parseThreshold(flagValue(argv, '--entry'), '--entry') === undefined
      ? {}
      : {
          entryThreshold: parseThreshold(
            flagValue(argv, '--entry'),
            '--entry',
          )!,
        }),
    ...(parseThreshold(flagValue(argv, '--exit'), '--exit') === undefined
      ? {}
      : {
          exitThreshold: parseThreshold(flagValue(argv, '--exit'), '--exit')!,
        }),
    ...(parseTimestamp(flagValue(argv, '--since'), '--since') === undefined
      ? {}
      : { since: parseTimestamp(flagValue(argv, '--since'), '--since')! }),
    ...(parseTimestamp(flagValue(argv, '--until'), '--until') === undefined
      ? {}
      : { until: parseTimestamp(flagValue(argv, '--until'), '--until')! }),
    clock: () => Date.now() as TimestampMs,
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
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('simulations-cli.ts')

if (invokedDirectly) {
  try {
    const output = runSimulationsCli(process.argv.slice(2), process.cwd())
    if (!process.argv.includes('--out')) process.stdout.write(output)
    else process.stdout.write(`Simulations complete. Summary written.\n`)
  } catch (error) {
    process.stderr.write(
      `simulations:run failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
