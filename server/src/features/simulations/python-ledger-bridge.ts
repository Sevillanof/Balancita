import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  resample1mTo15m,
  runFastReplay,
  type FastReplayCandle,
  type FastReplayDecisionSnapshot,
} from './fast-replay-engine.ts'

const PYTHON_TIMEOUT_MS = 10_000
const PYTHON_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const PYTHON_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../python',
)
const REPOSITORY_DIRECTORY = resolve(PYTHON_DIRECTORY, '..')

export class PythonLedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PythonLedgerUnavailableError'
  }
}

export class PythonLedgerTimeoutError extends Error {
  constructor() {
    super('The Python ledger process exceeded its 10-second time limit.')
    this.name = 'PythonLedgerTimeoutError'
  }
}

export class PythonLedgerExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PythonLedgerExecutionError'
  }
}

export interface PythonLedgerReplayResponse {
  readonly status: 'replayed' | 'no_new_closed_bar' | 'stale'
  readonly strategyId: string
  readonly configId: string
  readonly costIdentity: {
    readonly commissionRate: number
    readonly slippageRate: number
  }
  readonly parameters: {
    readonly startingCash: number
  }
  readonly inputWindow: {
    readonly barCount: number
    readonly barTimesMs: readonly number[]
    readonly cutoffMs: number
  }
  readonly decisionInputs: readonly {
    readonly time: number
    readonly probabilityUp: number
    readonly probabilityDown: number
    readonly abstained: boolean
    readonly directTarget: 'flat' | 'long'
  }[]
  readonly ledger: null | {
    readonly fills: readonly {
      readonly time: number
      readonly side: string
      readonly price: number
      readonly qty: number
      readonly commission: number
    }[]
    readonly metrics: {
      readonly finalEquity: number
      readonly tradeCount: number
      readonly winRate: number | null
      readonly profitFactor: number | null
    }
  }
  readonly executionAudit: {
    readonly version: 'python-replay-execution.v1'
    readonly availabilityBasis: string
    readonly executionBasis: string
    readonly comparability: string
    readonly fills: readonly {
      readonly fillIndex: number
      readonly fillSide: string
      readonly legacyLedgerTimeMs: number
      readonly timingStatus: string
      readonly decisionCandleCloseMs: number | null
      readonly decisionSignalTimeMs: number | null
      readonly decisionAvailableAtMs: number | null
      readonly executionAtMs: number | null
    }[]
  }
  readonly [key: string]: unknown
}

export async function runPythonLedgerBridge(input: {
  readonly strategyId: string
  readonly candles: readonly FastReplayCandle[]
  readonly startingCash: number
}): Promise<{
  readonly typescriptResult: ReturnType<typeof runFastReplay>
  readonly pythonLedger: PythonLedgerReplayResponse
}> {
  const trace: FastReplayDecisionSnapshot[] = []
  const typescriptResult = runFastReplay({
    strategyId: input.strategyId,
    candles: input.candles,
    ticketEur: input.startingCash,
    onDecision: (snapshot) => trace.push(snapshot),
  })
  const resampled = resample1mTo15m(input.candles, Number.MAX_SAFE_INTEGER)
  if (resampled.length === 0)
    throw new PythonLedgerExecutionError(
      'At least one complete 15-minute candle is required for the Python ledger.',
    )

  const bars = resampled.map((candle) => ({
    time: (candle.timestamp + 900) * 1000,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }))
  const signals = trace.map((decision) => ({
    time: (decision.timestamp + 900) * 1000,
    probabilityUp: 0.5,
    probabilityDown: 0.5,
    abstained: false,
    directTarget: decision.effectiveTarget,
  }))
  const cutoffMs = bars.at(-1)!.time
  const pythonInput = {
    strategyId: typescriptResult.strategyId,
    configId: 'typescript-native-effective-targets.v1',
    timestampUnit: 'milliseconds',
    sourceIntervalMs: 900_000,
    cutoffMs,
    scanTimeMs: cutoffMs,
    maxAgeMs: 900_000,
    startingCash: input.startingCash,
    costs: { commissionRate: 0.008, slippageRate: 0.0005 },
    bars,
    signals,
  }
  const pythonLedger = await executePython(pythonInput)
  return { typescriptResult, pythonLedger }
}

function executePython(input: unknown): Promise<PythonLedgerReplayResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('python3', ['-m', 'balancita_replay_cli'], {
      cwd: REPOSITORY_DIRECTORY,
      env: { ...process.env, PYTHONPATH: PYTHON_DIRECTORY },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let timedOut = false
    let outputExceeded = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, PYTHON_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > PYTHON_MAX_OUTPUT_BYTES) {
        outputExceeded = true
        child.kill('SIGKILL')
      } else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      if (error.code === 'ENOENT')
        rejectPromise(
          new PythonLedgerUnavailableError(
            'python3 is unavailable; no TypeScript-only fallback was run.',
          ),
        )
      else rejectPromise(new PythonLedgerExecutionError(error.message))
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut) {
        rejectPromise(new PythonLedgerTimeoutError())
        return
      }
      if (outputExceeded) {
        rejectPromise(
          new PythonLedgerExecutionError(
            'The Python ledger response exceeded the output-size limit.',
          ),
        )
        return
      }
      const errorText = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        if (errorText.includes("No module named 'balancita_replay_cli'")) {
          rejectPromise(
            new PythonLedgerUnavailableError(
              'The Python replay module is unavailable; no TypeScript-only fallback was run.',
            ),
          )
          return
        }
        rejectPromise(
          new PythonLedgerExecutionError(
            errorText.slice(0, 1000) || `Python exited with status ${code}.`,
          ),
        )
        return
      }
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(stdout).toString('utf8'),
        )
        resolvePromise(validatePythonResult(parsed))
      } catch (error) {
        rejectPromise(
          error instanceof PythonLedgerExecutionError
            ? error
            : new PythonLedgerExecutionError(
                'The Python ledger returned invalid JSON.',
              ),
        )
      }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(input))
  })
}

function validatePythonResult(value: unknown): PythonLedgerReplayResponse {
  const validTime = (time: unknown) => time === null || isSafeInteger(time)
  if (
    !isRecord(value) ||
    !['replayed', 'no_new_closed_bar', 'stale'].includes(
      String(value.status),
    ) ||
    typeof value.strategyId !== 'string' ||
    typeof value.configId !== 'string' ||
    !isRecord(value.costIdentity) ||
    value.costIdentity.commissionRate !== 0.008 ||
    value.costIdentity.slippageRate !== 0.0005 ||
    !isRecord(value.parameters) ||
    !isFiniteNumber(value.parameters.startingCash) ||
    !isRecord(value.inputWindow) ||
    !isSafeInteger(value.inputWindow.barCount) ||
    !Array.isArray(value.inputWindow.barTimesMs) ||
    value.inputWindow.barCount !== value.inputWindow.barTimesMs.length ||
    !value.inputWindow.barTimesMs.every(isSafeInteger) ||
    !isSafeInteger(value.inputWindow.cutoffMs) ||
    !Array.isArray(value.decisionInputs) ||
    !value.decisionInputs.every(
      (signal) =>
        isRecord(signal) &&
        isSafeInteger(signal.time) &&
        isFiniteNumber(signal.probabilityUp) &&
        isFiniteNumber(signal.probabilityDown) &&
        typeof signal.abstained === 'boolean' &&
        (signal.directTarget === 'flat' || signal.directTarget === 'long'),
    ) ||
    !isRecord(value.executionAudit) ||
    value.executionAudit.version !== 'python-replay-execution.v1' ||
    typeof value.executionAudit.availabilityBasis !== 'string' ||
    typeof value.executionAudit.executionBasis !== 'string' ||
    typeof value.executionAudit.comparability !== 'string' ||
    !Array.isArray(value.executionAudit.fills) ||
    !value.executionAudit.fills.every(
      (fill) =>
        isRecord(fill) &&
        isSafeInteger(fill.fillIndex) &&
        typeof fill.fillSide === 'string' &&
        isSafeInteger(fill.legacyLedgerTimeMs) &&
        typeof fill.timingStatus === 'string' &&
        validTime(fill.decisionCandleCloseMs) &&
        validTime(fill.decisionSignalTimeMs) &&
        validTime(fill.decisionAvailableAtMs) &&
        validTime(fill.executionAtMs),
    ) ||
    !(value.ledger === null || isRecord(value.ledger))
  )
    throw new PythonLedgerExecutionError(
      'The Python ledger response did not match the replay schema.',
    )
  if (!allNumbersFinite(value))
    throw new PythonLedgerExecutionError(
      'The Python ledger response contained a non-finite number.',
    )
  if (value.ledger !== null) {
    if (
      !Array.isArray(value.ledger.fills) ||
      !value.ledger.fills.every(
        (fill) =>
          isRecord(fill) &&
          isSafeInteger(fill.time) &&
          ['buy', 'sell', 'sell_short', 'buy_to_cover'].includes(
            String(fill.side),
          ) &&
          isFiniteNumber(fill.price) &&
          isFiniteNumber(fill.qty) &&
          isFiniteNumber(fill.commission),
      ) ||
      !Array.isArray(value.ledger.equityCurve) ||
      !isRecord(value.ledger.metrics) ||
      !isFiniteNumber(value.ledger.metrics.finalEquity) ||
      !isSafeInteger(value.ledger.metrics.tradeCount) ||
      !(
        value.ledger.metrics.winRate === null ||
        isFiniteNumber(value.ledger.metrics.winRate)
      ) ||
      !(
        value.ledger.metrics.profitFactor === null ||
        isFiniteNumber(value.ledger.metrics.profitFactor)
      )
    )
      throw new PythonLedgerExecutionError(
        'The Python ledger output did not contain validated ledger metrics.',
      )
    const fills = value.ledger.fills
    if (
      Array.isArray(fills) &&
      value.executionAudit.fills.some(
        (fill) =>
          isRecord(fill) &&
          isSafeInteger(fill.fillIndex) &&
          fill.fillIndex >= fills.length,
      )
    )
      throw new PythonLedgerExecutionError(
        'The Python execution audit referenced an unknown ledger fill.',
      )
  }
  return value as unknown as PythonLedgerReplayResponse
}

function allNumbersFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(allNumbersFinite)
  if (isRecord(value)) return Object.values(value).every(allNumbersFinite)
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
