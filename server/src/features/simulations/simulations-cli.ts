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
  type SimulationsRunnerResult,
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
  const stage = flagValue(argv, '--stage')
  if (stage !== undefined && stage !== 'smoke' && stage !== 'confirm')
    throw new Error('--stage must be smoke or confirm.')
  const seedRaw = flagValue(argv, '--seed')
  const seed = seedRaw === undefined ? undefined : Number(seedRaw)
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0))
    throw new Error('--seed must be a non-negative safe integer.')
  if (stage !== undefined && seed === undefined)
    throw new Error('--seed is required when --stage is specified.')
  const horizons =
    stage === 'smoke'
      ? ['15m' as const]
      : stage === 'confirm'
        ? ['15m' as const, '1h' as const]
        : parseHorizons(flagValue(argv, '--horizon'))
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
    ...(stage === undefined ? {} : { stage }),
    ...(seed === undefined ? {} : { seed }),
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

export function formatMicroCandidateTable(
  result: Pick<SimulationsRunnerResult, 'candleCount' | 'horizons'>,
): string {
  const diagnosticHorizons = result.horizons.filter(
    ({ report }) => report.microCandidateDiagnostics !== null,
  )
  if (diagnosticHorizons.length === 0) return ''
  const sampleLabels = diagnosticHorizons.map(
    ({ horizon, report }) =>
      `N_${horizon}=${report.microCandidateDiagnostics!.validationBaselines.uniform.count}`,
  )
  const lines = [
    `[PRELIMINAR - BUFFER ${result.candleCount}m - ${sampleLabels.join(' / ')}]`,
    'Micro candidate diagnostic validation (consumed holdout)',
    'horizon | candidate | matured | Brier | fills | closed round trips',
  ]
  for (const { horizon, report } of diagnosticHorizons) {
    const diagnostics = report.microCandidateDiagnostics!
    for (const candidate of diagnostics.candidates) {
      lines.push([
        horizon,
        candidate.candidateId,
        candidate.validationMaturedCount,
        formatNumber(candidate.validationBrier),
        candidate.validationFillCount,
        candidate.validationRoundTripCount,
      ].join(' | '))
    }
    for (const name of ['uniform', 'noChange', 'momentum'] as const) {
      const metric = diagnostics.validationBaselines[name]
      const profitability = report.profitability?.baselines[name].validation.metrics
      lines.push([
        horizon,
        name,
        metric.count,
        formatNumber(metric.brier),
        profitability?.fillCount ?? 0,
        profitability?.tradeCount ?? 0,
      ].join(' | '))
    }
  }
  return lines.join('\n')
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('simulations-cli.ts')

if (invokedDirectly) {
  try {
    const output = runSimulationsCli(process.argv.slice(2), process.cwd())
    if (!process.argv.includes('--out')) process.stdout.write(output)
    else process.stdout.write(`Simulations complete. Summary written.\n`)
    // The JSON remains the machine-readable result; this compact table makes
    // the consumed micro holdout diagnostic immediately readable in a terminal.
    const parsed = JSON.parse(output) as Pick<
      SimulationsRunnerResult,
      'candleCount' | 'horizons'
    >
    const table = formatMicroCandidateTable(parsed)
    if (table !== '') process.stdout.write(`${table}\n`)
  } catch (error) {
    process.stderr.write(
      `simulations:run failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
