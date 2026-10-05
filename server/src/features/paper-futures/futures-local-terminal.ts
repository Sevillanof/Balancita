import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readFileSync } from 'node:fs'
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  registerTerminalStream,
  type PaperCommandAction,
} from '../terminal-stream/terminal-stream.js'
import { FuturesCommandRunner } from './futures-command-runner.js'
import { FuturesStore } from './futures-store.js'
import type { FuturesWorkerRequest } from './futures-worker.js'
import {
  buildLocalScenarioSnapshot,
  localScenarioRuntime,
  recoverLocalScenarioProgress,
  runLocalFuturesScenario,
  type LocalScenario,
} from './futures-local-scenario.js'

const fixturePath = new URL(
  './fixtures/local-protection.v1.json',
  import.meta.url,
)
const fixtureText = readFileSync(fixturePath, 'utf8')
const fixture = JSON.parse(fixtureText) as Record<string, unknown>
const scenarioDefinition = fixture as unknown as LocalScenario
const instrumentId = 'kraken-futures:PF_XBTUSD'
const markerFile = 'local-terminal-output.json'
const stageNames = (scenarioDefinition.events as { name: string }[]).map(
  (event) => event.name,
)

/** Identity written into every output directory this launcher owns. */
export function localTerminalOutputMarker() {
  return {
    schema_version: 'local-futures-terminal-output.v1',
    mode: 'MOCK',
    scenario_run_id: String(fixture.run_id),
    fixture_sha256: createHash('sha256').update(fixtureText).digest('hex'),
  }
}

/**
 * Resolves a stage name or 1-based stage number to its 0-based index. The last
 * stage is rejected: interrupting after it would just be a completion.
 */
export function resolveInterruptStage(value: string | number): number {
  const text = String(value).trim()
  const byName = stageNames.slice(0, -1).indexOf(text)
  const index =
    byName >= 0 ? byName : /^[1-9]$/.test(text) ? Number(text) - 1 : -1
  if (index < 0 || index >= stageNames.length - 1)
    throw new Error(
      `Unknown interrupt stage "${text}"; use ${stageNames.slice(0, -1).join(', ')} or 1-${stageNames.length - 1}.`,
    )
  return index
}

function openResumableStore(outputDirectory: string): FuturesStore {
  const refuse = (reason: string) =>
    new Error(`Refusing to resume: ${reason} (${outputDirectory})`)
  if (!existsSync(outputDirectory) || !statSync(outputDirectory).isDirectory())
    throw refuse('output directory does not exist')
  let marker: unknown
  try {
    marker = JSON.parse(readFileSync(join(outputDirectory, markerFile), 'utf8'))
  } catch {
    throw refuse('directory was not created by the local MOCK terminal')
  }
  if (!isDeepStrictEqual(marker, localTerminalOutputMarker()))
    throw refuse('directory belongs to a different scenario or version')
  const databasePath = join(outputDirectory, 'paper-futures.sqlite')
  const unreadable = refuse('database is unreadable or has no scenario run')
  if (!existsSync(databasePath)) throw unreadable
  let store: FuturesStore
  try {
    store = new FuturesStore(databasePath)
  } catch {
    throw unreadable
  }
  try {
    const runId = String(fixture.run_id)
    const binding = store.getRuntimeBinding(runId)
    if (!store.getRunMetadata(runId) || !binding) throw unreadable
    if (
      !isDeepStrictEqual(
        binding.runtime_config,
        localScenarioRuntime.runtimeConfig,
      ) ||
      !isDeepStrictEqual(
        binding.instrument_spec,
        localScenarioRuntime.instrument,
      )
    )
      throw refuse('run binding differs from the local scenario')
    if (!store.verifyRun(runId))
      throw refuse('run failed integrity verification')
  } catch (error) {
    store.close()
    throw error instanceof Error && error.message.startsWith('Refusing')
      ? error
      : unreadable
  }
  return store
}

type TerminalEventInput = Parameters<
  FuturesStore['appendTerminalEvents']
>[1][number]

type LocalTerminalOptions = {
  port?: number
  outputDirectory?: string
  uiOrigin?: string
  pacingMs?: number
  /** Reopen an existing output directory of this launcher and continue it. */
  resume?: boolean
  /** Stage name or 1-based number; stop cleanly after it commits. */
  interruptAfterStage?: string | number
  wait?: (milliseconds: number) => Promise<void>
  onLog?: (line: string) => void
  /** Test seam: awaited while a scripted stage is accepted but not committed. */
  onStageInFlight?: (stage: { runId: string; index: number }) => Promise<void>
}

export type LocalTerminalHandle = {
  readonly apiUrl: string
  readonly outputDirectory: string
  readonly databasePath: string
  readonly runId: string
  readonly app: FastifyInstance
  /** Resolves only when `interruptAfterStage` was reached and committed. */
  readonly interrupted: Promise<{ stage: string; index: number }>
  close(): Promise<void>
}

export async function startLocalFuturesTerminal(
  options: LocalTerminalOptions = {},
): Promise<LocalTerminalHandle> {
  const port = options.port ?? 8787
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
    throw new Error('API port must be an integer between 0 and 65535.')
  const resume = options.resume === true
  const interruptIndex =
    options.interruptAfterStage === undefined
      ? undefined
      : resolveInterruptStage(options.interruptAfterStage)
  if (resume && !options.outputDirectory)
    throw new Error(
      '--resume requires an existing output directory (--output-dir).',
    )
  const outputDirectory = options.outputDirectory
    ? resolve(options.outputDirectory)
    : mkdtempSync(join(tmpdir(), 'balancita-local-terminal-'))
  const databasePath = join(outputDirectory, 'paper-futures.sqlite')
  let store: FuturesStore
  if (resume) store = openResumableStore(outputDirectory)
  else {
    if (options.outputDirectory) {
      if (existsSync(outputDirectory))
        throw new Error(
          `Refusing existing terminal output path: ${outputDirectory}`,
        )
      mkdirSync(outputDirectory, { recursive: true })
    }
    writeFileSync(
      join(outputDirectory, markerFile),
      JSON.stringify(localTerminalOutputMarker()),
    )
    store = new FuturesStore(databasePath)
  }
  const runner = new FuturesCommandRunner(store)
  const app = Fastify({ logger: false })
  const runId = String(fixture.run_id)
  const uiOrigin = options.uiOrigin ?? 'http://127.0.0.1:5174'
  const pacingMs = options.pacingMs ?? 3_500
  type RunState = {
    message: string
    scenarioStatus: string
    started: boolean
    latestSnapshot: Record<string, unknown> | undefined
    lastRiskKey: string | undefined
    commands: Set<Promise<void>>
    stage: { settled: Promise<void>; settle: () => void } | undefined
  }
  const resumeProgress = resume
    ? recoverLocalScenarioProgress(scenarioDefinition, store)
    : undefined
  const resumeMessage = resumeProgress
    ? `Escenario reanudado desde SQLite (MOCK): ${resumeProgress.committedStages} de ${stageNames.length} etapas ya confirmadas; continúa en la etapa ${Math.min(resumeProgress.nextStageIndex + 1, stageNames.length)}`
    : undefined
  const runs = new Map<string, RunState>()
  const registerRun = (target: string) => {
    const state: RunState = {
      message:
        target === String(fixture.run_id) && resumeMessage
          ? resumeMessage
          : 'Escenario iniciado',
      scenarioStatus: 'running',
      started: false,
      latestSnapshot: undefined,
      lastRiskKey: undefined,
      commands: new Set(),
      stage: undefined,
    }
    runs.set(target, state)
    return state
  }
  registerRun(runId)
  const scenarios: Promise<unknown>[] = []
  let signalInterrupted!: (value: { stage: string; index: number }) => void
  const interrupted = new Promise<{ stage: string; index: number }>(
    (resolveInterrupted) => {
      signalInterrupted = resolveInterrupted
    },
  )
  let activeRunId = runId
  let closing = false
  let releaseSubscription: (() => void) | undefined
  let releaseClosing: (() => void) | undefined
  const subscription = new Promise<void>((resolveSubscription) => {
    releaseSubscription = resolveSubscription
  })
  const closingSignal = new Promise<void>((resolveClosing) => {
    releaseClosing = resolveClosing
  })
  const durableRisk = (target: string): Record<string, boolean> | null => {
    const checkpoint = store.getRunProjection(target)?.checkpoint
    const risk = isRecord(checkpoint) ? checkpoint.risk_checkpoint : undefined
    if (!isRecord(risk)) return null
    return {
      user_paused: risk.user_paused === true,
      entry_paused: risk.entry_paused === true,
      daily_loss_latched: risk.daily_loss_latched === true,
      system_paused: risk.system_paused === true,
    }
  }
  const emitStatus = (
    target: string,
    scenarioStatus: string,
    message: string,
  ) => {
    const state = runs.get(target)!
    state.message = message
    state.scenarioStatus = scenarioStatus
    const risk = durableRisk(target)
    state.lastRiskKey = JSON.stringify(risk)
    store.appendTerminalEvents(target, [
      {
        type: 'engine.status',
        eventTime: Date.now(),
        data: { scenario_status: scenarioStatus, message, risk },
      },
    ])
  }
  const settleCommands = async (target: string) => {
    const state = runs.get(target)
    while (state && state.commands.size > 0)
      await Promise.all([...state.commands])
  }
  const candleEntries = (
    snapshot: Record<string, unknown> | undefined,
    all: boolean,
  ): TerminalEventInput[] => {
    const inputEvents = (snapshot?.events ?? []) as Record<string, unknown>[]
    const candleInputs = inputEvents.filter(
      (event) => event.type === 'candle' && event.interval_ms === 60_000,
    )
    return (all ? candleInputs : candleInputs.slice(-1)).map((candle) => ({
      type: 'market.updated',
      eventTime: Number(candle.event_time_ms),
      data: {
        market_status: 'open',
        last_received_at: Number(candle.received_at_ms),
        candle: {
          bucket_start_ms: candle.bucket_start_ms,
          interval_ms: candle.interval_ms,
          known_at_ms: candle.known_at_ms,
          closed: candle.closed,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume_btc: candle.volume_btc,
        },
      },
    }))
  }

  app.get('/api/terminal/bootstrap', async () => {
    store.getTerminalSnapshot(activeRunId)
    const active = runs.get(activeRunId)!
    const page = store.listTerminalEvents(activeRunId, {
      afterSeq: 0,
      limit: 500,
    })
    const candles = new Map<number, Record<string, unknown>>()
    for (const event of page.events) {
      if (event.type !== 'market.updated') continue
      const candle = event.data.candle
      if (typeof candle !== 'object' || candle === null) continue
      const value = candle as Record<string, unknown>
      if (!Number.isSafeInteger(value.bucket_start_ms)) continue
      candles.set(Number(value.bucket_start_ms), {
        time_ms: value.bucket_start_ms,
        open: value.open,
        high: value.high,
        low: value.low,
        close: value.close,
        volume_btc: value.volume_btc,
        closed: value.closed,
      })
    }
    const latestMarket = [...page.events]
      .reverse()
      .find((event) => event.type === 'market.updated')
    return {
      schema_version: 1,
      mode: 'mock',
      source: 'local-protection.v1',
      active_run_id: activeRunId,
      instrument_id: instrumentId,
      source_manifest: { source: 'local-protection.v1' },
      terminal_market: {
        schema_version: 'mock-terminal-market.v1',
        as_of_ms: latestMarket?.event_time ?? 0,
        interval_ms: 60_000,
        candles: [...candles.values()]
          .sort((left, right) => Number(left.time_ms) - Number(right.time_ms))
          .slice(-500),
      },
      market: latestMarket?.data ?? {},
      engine: {
        status: 'ready',
        scenario_status: active.message,
        risk: durableRisk(activeRunId),
      },
    }
  })

  const startScenario = (target: string, child: boolean) => {
    const state = runs.get(target)!
    const promise = runLocalFuturesScenario(
      { ...scenarioDefinition, run_id: target } as never,
      {
        outputDirectory,
        store,
        runner,
        interactive: true,
        ...(child ? { adoptExistingRun: true } : {}),
        ...(resumeProgress && target === runId
          ? {
              adoptExistingRun: true,
              startIndex: resumeProgress.nextStageIndex,
            }
          : {}),
        ...(interruptIndex !== undefined && target === runId
          ? { stopAfterIndex: interruptIndex }
          : {}),
        beforeWork: async (index) => {
          await settleCommands(target)
          // The stage is accepted synchronously after this point; commands
          // that arrive until it commits are serialized behind it.
          if (index < scenarioDefinition.events.length) {
            let settle!: () => void
            const settled = new Promise<void>((resolveStage) => {
              settle = resolveStage
            })
            state.stage = { settled, settle }
          }
        },
        afterAccept: (index) =>
          options.onStageInFlight?.({ runId: target, index }) ??
          Promise.resolve(),
        onStage: async (stage) => {
          if (stage.kind === 'started') {
            if (child) return
            await Promise.race([subscription, closingSignal])
            if (closing && !state.started)
              throw new Error('local_terminal_closed_before_subscribe')
            return
          }
          if (stage.kind === 'committed') {
            if (closing)
              throw new Error('local_terminal_closed_during_scenario')
            state.latestSnapshot = stage.marketSnapshot
            state.stage?.settle()
            state.stage = undefined
            const entries = candleEntries(
              stage.marketSnapshot,
              stage.index === 0,
            )
            if (entries.length) store.appendTerminalEvents(target, entries)
            if (JSON.stringify(durableRisk(target)) !== state.lastRiskKey)
              emitStatus(target, state.scenarioStatus, state.message)
            if (
              stage.index !== undefined &&
              stage.index < 4 &&
              stage.index !== interruptIndex &&
              pacingMs > 0
            )
              await (options.wait ?? delay)(pacingMs)
          }
          if (stage.kind === 'interrupted') {
            const name = stageNames[stage.index!]!
            emitStatus(
              target,
              'interrupted',
              `Escenario interrumpido tras ${name} (MOCK); reanudar con --resume sobre el mismo --output-dir`,
            )
            signalInterrupted({ stage: name, index: stage.index! })
          }
          if (stage.kind === 'completed')
            emitStatus(target, 'completed', 'Escenario finalizado')
        },
      },
    )
    void promise.catch((error: unknown) => {
      state.stage?.settle()
      state.stage = undefined
      if (closing) return
      const message = error instanceof Error ? error.message : String(error)
      try {
        emitStatus(target, 'failed', `Escenario fallido: ${message}`)
      } catch {
        options.onLog?.(`Scenario failed: ${message}`)
      }
    })
    scenarios.push(promise)
  }

  const controlRequest = (
    command: Parameters<
      typeof registerTerminalStream
    >[1]['commandFactory'] extends (value: infer Command) => unknown
      ? Command
      : never,
  ): FuturesWorkerRequest => {
    const state = runs.get(command.run_id)
    if (
      !state ||
      (command.action !== 'paper.pause' && command.action !== 'paper.resume')
    )
      throw new Error('local_demo_unsupported_command')
    // The control cycle replays the run's latest committed scripted market
    // (same book identity and clock), so it can neither fill liquidity twice
    // nor move the scripted time; only the entry-pause flag changes.
    const snapshot = structuredClone(
      state.latestSnapshot ?? buildLocalScenarioSnapshot(scenarioDefinition, 0),
    )
    return {
      request_id: command.command_id,
      run_id: command.run_id,
      work_id: command.command_id,
      expected_state_version: command.expected_state_version,
      payload: {
        operation: 'futures_runtime.v3',
        runtime_config: localScenarioRuntime.runtimeConfig,
        instrument: localScenarioRuntime.instrument,
        market_snapshot: snapshot,
        control: { type: command.action, command_id: command.command_id },
      },
    }
  }

  registerTerminalStream(app, {
    store,
    runner,
    allowedOrigins: [uiOrigin],
    commandFactory: controlRequest,
    newRunFactory: (command, childRunId) => {
      if (!runs.has(command.run_id)) throw new Error('local_demo_unknown_run')
      return {
        request_id: command.command_id,
        run_id: childRunId,
        work_id: command.command_id,
        expected_state_version: 0,
        payload: {
          operation: 'futures_runtime.v3',
          runtime_config: localScenarioRuntime.runtimeConfig,
          instrument: localScenarioRuntime.instrument,
          market_snapshot: buildLocalScenarioSnapshot(scenarioDefinition, 0),
        },
      }
    },
    onNewRunCreated: (childRunId) => {
      registerRun(childRunId).latestSnapshot = buildLocalScenarioSnapshot(
        scenarioDefinition,
        0,
      )
    },
    commandExecutor: (request, metadata) => {
      const state =
        metadata.action === 'paper.new_run'
          ? undefined
          : runs.get(request.run_id)
      const inFlight = state?.stage
      let accepted: ReturnType<typeof runner.accept>
      if (state && inFlight) {
        // A stage is accepted but not committed: its commit would supersede a
        // command built on the same version. Serialize the command behind it,
        // rebuilding it on the post-stage durable version and market clock.
        options.onLog?.(`Command deferred behind stage: ${metadata.command_id}`)
        accepted = {
          acknowledgement: {
            command_id: metadata.command_id,
            status: 'accepted',
          },
          result: inFlight.settled.then(() => {
            const version = Number(
              store.getRunProjection(request.run_id)!.state_version,
            )
            const rebuilt = controlRequest({
              command_id: metadata.command_id,
              run_id: request.run_id,
              expected_state_version: version,
              action: metadata.action as PaperCommandAction,
            })
            return runner.accept(rebuilt, {
              ...metadata,
              expected_state_version: version,
            }).result
          }),
        }
      } else accepted = runner.accept(request, metadata)
      if (state) {
        const tracked: Promise<void> = accepted.result
          .then(
            () => undefined,
            () => undefined,
          )
          .then(() => {
            if (closing) return
            try {
              emitStatus(request.run_id, state.scenarioStatus, state.message)
            } catch {
              // The store is closing; the durable command result is already stored.
            }
          })
          .finally(() => state.commands.delete(tracked))
        state.commands.add(tracked)
      }
      return accepted
    },
    afterSnapshot: async (target) => {
      const state = runs.get(target)
      if (!state || closing) return
      const first = !state.started
      state.started = true
      setImmediate(() => {
        if (closing) return
        try {
          if (!first) {
            emitStatus(target, state.scenarioStatus, state.message)
            return
          }
          if (target === runId) {
            emitStatus(
              target,
              'running',
              resumeMessage ?? 'Escenario ejecutándose',
            )
            releaseSubscription?.()
            return
          }
          activeRunId = target
          emitStatus(target, 'running', 'Escenario ejecutándose')
          startScenario(target, true)
        } catch (error) {
          options.onLog?.(
            `Snapshot hook failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
    },
  })

  try {
    await app.listen({ host: '127.0.0.1', port })
  } catch (error) {
    await app.close()
    await runner.close()
    store.close()
    throw error
  }
  const address = app.server.address()
  if (!address || typeof address === 'string')
    throw new Error('API bind failed.')
  const actualPort = address.port

  if (resumeProgress) {
    // A crash can fall between a stage's durable commit and its market
    // presentation: restore any committed stage's candles that are missing.
    store.getTerminalSnapshot(runId)
    const present = new Set(
      store
        .listTerminalEvents(runId, { afterSeq: 0, limit: 500 })
        .events.flatMap((event) =>
          event.type === 'market.updated' && isRecord(event.data.candle)
            ? [Number(event.data.candle.bucket_start_ms)]
            : [],
        ),
    )
    for (let index = 0; index < resumeProgress.nextStageIndex; index += 1) {
      const missing = candleEntries(
        buildLocalScenarioSnapshot(scenarioDefinition, index, {
          tolerateMissingProtection: true,
        }),
        index === 0,
      ).filter((entry) => {
        const bucket = Number(
          (entry.data.candle as Record<string, unknown>).bucket_start_ms,
        )
        if (present.has(bucket)) return false
        present.add(bucket)
        return true
      })
      if (missing.length) store.appendTerminalEvents(runId, missing)
    }
    if (resumeProgress.nextStageIndex > 0)
      runs.get(runId)!.latestSnapshot = buildLocalScenarioSnapshot(
        scenarioDefinition,
        resumeProgress.nextStageIndex - 1,
        { store, runId, tolerateMissingProtection: true },
      )
  }
  startScenario(runId, false)

  options.onLog?.(
    `API http://127.0.0.1:${actualPort} · DB ${databasePath} · source local-protection.v1 · funding=0 fixture only${resumeProgress ? ` · RESUMED at stage ${Math.min(resumeProgress.nextStageIndex + 1, stageNames.length)}/${stageNames.length}` : ''}`,
  )
  return {
    apiUrl: `http://127.0.0.1:${actualPort}`,
    outputDirectory,
    databasePath,
    runId,
    app,
    interrupted,
    async close() {
      closing = true
      releaseClosing?.()
      await Promise.allSettled(scenarios)
      // An attached browser keeps its stream socket open; never let that hold
      // back the durable close of the run (the process exits right after).
      await Promise.race([app.close(), delay(2_000)])
      await runner.close()
      store.close()
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
