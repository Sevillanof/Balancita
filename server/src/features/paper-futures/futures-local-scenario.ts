import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { FuturesCommandRunner } from './futures-command-runner.ts'
import { canonicalHash } from './futures-canonical.ts'
import { FuturesStore } from './futures-store.ts'

const instrument = {
  instrument_id: 'kraken-futures:PF_XBTUSD',
  provider_symbol: 'PF_XBTUSD',
  quantity_step_btc: '0.0001',
  minimum_quantity_btc: '0.0001',
  price_tick_usd: '1',
}
const baseConfig = {
  version: 'futures-runtime-risk.v1',
  initial_cash_usd: '10000',
  max_notional_usd: '1000',
  risk_fraction: '0.001',
  daily_loss_fraction: '0.01',
  max_exposure_multiple: '1',
  max_spread_bps: '5',
  max_book_age_ms: 3000,
  execution_latency_ms: 100,
  maker_rate: '0.0002',
  taker_rate: '0.0005',
  cost_version: 'kraken-futures-eea-btcusd-base.v1',
  funding_policy_version: 'funding-separation.v1',
  strategy_selection_policy_version: 'strategy-selection-cadence.v1',
  strategy_selection_interval_ms: 5000,
}
const strategyManifest = {
  config_version: 'futures-strategies-config.v1',
  indicator_version: 'futures-closed-indicators.v1',
  strategy_ids: [
    'c25-pullback-perp-v1',
    'c26-reversion-perp-v1',
    'c27-breakout-perp-v1',
    'c28-adapter-perp-v1',
  ],
}
const admissionPolicy = {
  schema_version: 'futures-entry-admission.v1',
  evaluation_interval_ms: 5000,
}

type Scenario = {
  schema_version: string
  mode: string
  run_id: string
  base_time_ms: number
  input_provenance: string
  funding: {
    source: string
    raw_rate: string
    unit: string
    known_at_ms: number
    effective_start_ms: number
    effective_end_ms: number
  }
  events: {
    name: string
    time_ms: number
    breakout: boolean
    book_quantity_btc: string
  }[]
}

export async function runLocalFuturesScenario(
  scenario: Scenario,
  options: { outputDirectory?: string; inputSha256?: string } = {},
) {
  validateScenario(scenario)
  const outputDirectory = options.outputDirectory
    ? resolve(options.outputDirectory)
    : mkdtempSync(join(tmpdir(), 'balancita-local-futures-'))
  if (options.outputDirectory) {
    if (existsSync(outputDirectory))
      throw new Error(
        `Refusing existing scenario output path: ${outputDirectory}`,
      )
    mkdirSync(dirname(outputDirectory), { recursive: true })
    mkdirSync(outputDirectory)
  }
  const databasePath = join(outputDirectory, 'paper-futures.sqlite')
  const fixtureHash =
    options.inputSha256 ??
    createHash('sha256').update(JSON.stringify(scenario)).digest('hex')
  const runtimeConfig = { ...baseConfig }
  const store = new FuturesStore(databasePath)
  const runId = scenario.run_id
  const runner = new FuturesCommandRunner(store)
  let report: Record<string, unknown> | undefined
  try {
    store.createRun({
      runId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
        mode: 'paper_live',
      },
      seed: { cash_usd: '10000', source: 'paper_live' },
      instrument: { instrument_id: instrument.instrument_id },
      costs: {
        version: runtimeConfig.cost_version,
        maker: runtimeConfig.maker_rate,
        taker: runtimeConfig.taker_rate,
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v5',
        runtime_config: runtimeConfig,
        instrument_spec: instrument,
        strategy_manifest: strategyManifest,
        strategy_config_hash: canonicalHash(strategyManifest),
        admission_policy: {
          ...admissionPolicy,
          hash: canonicalHash(admissionPolicy),
        },
      },
    })

    let stateVersion = 0
    const receipts: Record<string, unknown>[] = []
    const outputs: Record<string, unknown>[] = []
    for (const [index, event] of scenario.events.entries()) {
      const snapshot = scenarioSnapshot(event.time_ms, event.breakout)
      setBookQuantity(snapshot, event.book_quantity_btc)
      if (event.name === 'warmup') addFixtureFunding(snapshot, scenario.funding)
      if (event.name === 'protective-stop-crossing') {
        const checkpoint = store.getRunProjection(runId)?.checkpoint as
          Record<string, unknown> | undefined
        const protection = checkpoint?.position_protection as
          Record<string, unknown> | undefined
        if (typeof protection?.stop !== 'string')
          throw new Error('Real strategy did not establish protective stop.')
        setStopCrossing(snapshot, BigInt(protection.stop))
      }
      if (event.name === 'protective-close-fill') {
        const checkpoint = store.getRunProjection(runId)?.checkpoint as
          Record<string, unknown> | undefined
        const protection = checkpoint?.position_protection as
          Record<string, unknown> | undefined
        if (typeof protection?.stop !== 'string')
          throw new Error('Protective stop disappeared before its fill.')
        setStopCrossing(snapshot, BigInt(protection.stop))
      }
      const workId = `${runId}-${index + 1}-${event.name}`
      const accepted = runner.accept({
        request_id: `request-${workId}`,
        run_id: runId,
        work_id: workId,
        expected_state_version: stateVersion,
        payload: {
          operation: 'futures_runtime.v3',
          runtime_config: runtimeConfig,
          instrument,
          market_snapshot: snapshot,
        },
      })
      if (
        accepted.acknowledgement.status !== 'accepted' &&
        accepted.acknowledgement.status !== 'already_accepted'
      )
        throw new Error(`Work ${workId} was not durably accepted.`)
      await accepted.result
      const receipt = store.getAppliedReceipt(workId)
      if (!receipt || receipt.status !== 'committed')
        throw new Error(`Work ${workId} lacks its committed receipt.`)
      receipts.push(receipt)
      stateVersion += 1
      outputs.push(
        store.getAppliedRuntimeProjection(runId, workId, stateVersion)
          .runtime_output,
      )
    }

    const projection = store.getRunProjection(runId)
    const finalOutput = outputs.at(-1)!
    const initialOutput = outputs.find((output) => {
      const analysis = output.analysis as Record<string, unknown> | undefined
      return analysis?.selected_strategy_id === 'c27-breakout-perp-v1'
    })
    const entryOrder = (
      initialOutput?.orders as Record<string, unknown>[] | undefined
    )?.find((order) => order.type === 'order_accepted')
    const partialOutput = outputs.find((output) =>
      (output.fills as Record<string, unknown>[]).some(
        (fill) => fill.quantity_btc === '0.005' && fill.side === 'long',
      ),
    )
    const protectiveOrder = outputs
      .flatMap((output) => output.orders as Record<string, unknown>[])
      .find((order) => order.order_type === 'reduce_only')
    const protectionFill = outputs
      .flatMap((output) => output.fills as Record<string, unknown>[])
      .findLast((fill) => fill.side === 'long' && fill.quantity_btc === '0.005')
    const pendingCommands = store.loadPendingCommands()
    const checkpoint = projection?.checkpoint as
      Record<string, unknown> | undefined
    const executionCheckpoint = checkpoint?.execution_checkpoint as
      Record<string, unknown> | undefined
    const executionOrders = executionCheckpoint?.orders as
      Record<string, unknown> | undefined
    const ledger = finalOutput.ledger as Record<string, unknown>
    if (
      !entryOrder ||
      !partialOutput ||
      !protectiveOrder ||
      !protectionFill ||
      !executionOrders ||
      (finalOutput.position as Record<string, unknown>).quantity_btc !== '0' ||
      pendingCommands.length !== 0 ||
      projection?.state_version !== scenario.events.length ||
      !store.verifyRun(runId)
    )
      throw new Error('Scenario did not satisfy the durable protection path.')

    report = {
      schemaVersion: scenario.schema_version,
      mode: scenario.mode,
      runId,
      outputDirectory,
      databasePath,
      fixtureSha256: fixtureHash,
      runtimeConfigSha256: canonicalHash(runtimeConfig),
      orderIds: Object.keys(executionOrders),
      entryOrderId: entryOrder.order_id,
      entryEligibleAtMs: entryOrder.eligible_at_ms,
      partialFillQuantityBtc: '0.005',
      partialFillAtMs: (partialOutput?.fills as Record<string, unknown>[]).find(
        (fill) => fill.quantity_btc === '0.005',
      )?.event_time_ms,
      protectiveIntent: protectiveOrder.order_id,
      protectiveCloseQuantityBtc: protectionFill.quantity_btc,
      protectiveCloseAtMs: protectionFill.event_time_ms,
      protectionReason: protectiveOrder.reason_code ?? 'engine position stop',
      finalQuantityBtc: (finalOutput.position as Record<string, unknown>)
        .quantity_btc,
      equityUsd: ledger.equity_usd,
      feesUsd: ledger.fees_usd,
      realizedGrossUsd: ledger.realized_gross_usd,
      fundingPaid: ledger.funding_paid,
      committedAcknowledgements: receipts.length,
      durableEvents: (store.exportRun(runId).events as unknown[]).length,
      pendingCommands: pendingCommands.length,
      verified: true,
    }
  } finally {
    await runner.close()
    store.close()
  }
  if (!report) throw new Error('Scenario completed without a report.')
  const integrity = new FuturesStore(databasePath)
  let verifiedAfterReopen: boolean
  try {
    verifiedAfterReopen = integrity.verifyRun(runId)
  } finally {
    integrity.close()
  }
  if (!verifiedAfterReopen)
    throw new Error('Persisted run failed full integrity verification.')
  if (
    readdirSync(outputDirectory).some(
      (name) => name.endsWith('-wal') || name.endsWith('-shm'),
    )
  )
    throw new Error('SQLite left a WAL/SHM sidecar after graceful close.')
  if (!statSync(databasePath).isFile())
    throw new Error('Scenario database was not retained as a file.')
  return report
}

function validateScenario(value: Scenario): void {
  if (
    value?.schema_version !== 'local-futures-scenario.v1' ||
    value.mode !== 'LOCAL_SIMULATION' ||
    typeof value.run_id !== 'string' ||
    !/^[a-z0-9-]+$/.test(value.run_id) ||
    !Number.isSafeInteger(value.base_time_ms) ||
    !Array.isArray(value.events) ||
    value.events.length !== 5 ||
    value.events[0]?.name !== 'warmup' ||
    value.events[1]?.name !== 'entry-selection' ||
    value.events[2]?.name !== 'partial-fill' ||
    value.events[3]?.name !== 'protective-stop-crossing' ||
    value.events[4]?.name !== 'protective-close-fill' ||
    value.events.some(
      (event, index) =>
        !Number.isSafeInteger(event.time_ms) ||
        event.time_ms < value.base_time_ms ||
        (index > 0 && event.time_ms <= value.events[index - 1]!.time_ms) ||
        typeof event.book_quantity_btc !== 'string',
    ) ||
    value.events[1]?.time_ms !== value.base_time_ms + 5000 ||
    value.events[2]?.time_ms !== value.base_time_ms + 5100 ||
    value.events[3]?.time_ms !== value.base_time_ms + 5200 ||
    value.events[4]?.time_ms !== value.base_time_ms + 5300 ||
    value.funding?.raw_rate !== '0' ||
    value.funding.unit !== 'usd_per_btc_per_hour' ||
    value.funding.known_at_ms > value.base_time_ms ||
    value.funding.effective_start_ms > value.base_time_ms ||
    value.funding.effective_end_ms <= value.events.at(-1)!.time_ms
  )
    throw new Error('Invalid local futures scenario fixture.')
}

function scenarioSnapshot(time: number, breakout: boolean) {
  const candleCutoff = Math.floor(time / 60_000) * 60_000
  const events: Record<string, unknown>[] = []
  let reception = 0
  for (const interval of [60_000, 300_000]) {
    for (let index = 0; index < 60; index += 1) {
      const direction = breakout && interval === 60_000 && index === 59
      reception += 1
      const close = direction ? '100100' : '100000'
      events.push({
        type: 'candle',
        interval_ms: interval,
        bucket_start_ms: candleCutoff - (60 - index) * interval,
        event_time_ms: candleCutoff - (59 - index) * interval,
        received_at_ms: candleCutoff - (59 - index) * interval,
        known_at_ms: candleCutoff - (59 - index) * interval,
        reception_order: reception,
        closed: true,
        coverage: 'complete',
        open: '100000',
        high: direction ? '100101' : '100050',
        low: '99950',
        close,
        volume_btc: direction ? '2' : '1',
      })
    }
  }
  events.push(
    {
      type: 'book_snapshot',
      event_time_ms: time,
      received_at_ms: time,
      known_at_ms: time,
      reception_order: reception + 1,
      epoch: 'local-v1',
      sequence: Math.floor(time / 100),
      contiguous: true,
      valid: true,
      bids: [{ price_usd: '100000', quantity_btc: '1' }],
      asks: [{ price_usd: '100001', quantity_btc: '1' }],
    },
    {
      type: 'ticker',
      event_time_ms: time,
      received_at_ms: time,
      known_at_ms: time,
      reception_order: reception + 2,
      mark_usd: '100000.5',
      market_status: 'open',
    },
  )
  return {
    mode: 'mock',
    instrument,
    decision_time_ms: time,
    cutoff_received_at_ms: time,
    events,
  }
}

function setBookQuantity(snapshot: Record<string, unknown>, quantity: string) {
  const book = (snapshot.events as Record<string, unknown>[]).find(
    (event) => event.type === 'book_snapshot',
  )!
  book.asks = [{ price_usd: '100001', quantity_btc: quantity }]
}

function setStopCrossing(snapshot: Record<string, unknown>, stop: bigint) {
  for (const event of snapshot.events as Record<string, unknown>[]) {
    if (event.type === 'book_snapshot') {
      event.bids = [{ price_usd: (stop - 1n).toString(), quantity_btc: '1' }]
      event.asks = [{ price_usd: stop.toString(), quantity_btc: '1' }]
    } else if (event.type === 'ticker') event.mark_usd = (stop - 1n).toString()
  }
}

function addFixtureFunding(
  snapshot: Record<string, unknown>,
  funding: Scenario['funding'],
) {
  const events = snapshot.events as Record<string, unknown>[]
  events.push({
    type: 'funding_observation',
    received_at_ms: funding.known_at_ms,
    known_at_ms: funding.known_at_ms,
    observation: {
      ...funding,
      provider: 'kraken',
      product: 'PF_XBTUSD',
      field: 'funding_rate',
      received_seq: events.length + 1,
      observation_id: 'local-funding-v1',
      sha256: '0'.repeat(64),
      semantic_version: 'kraken-funding-normalization.v1',
      predicted: false,
    },
  })
}
