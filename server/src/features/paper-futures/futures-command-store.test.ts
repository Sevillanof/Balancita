import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FuturesCommandRunner } from './futures-command-runner.ts'
import { FuturesStore } from './futures-store.ts'
import type { FuturesWorkerRequest } from './futures-worker.ts'

describe('durable futures worker commands', () => {
  it('commits real Python ledger output, reopens, and replays without duplicate effects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-worker-command-'))
    const path = join(directory, 'fixture.sqlite')
    const command = request()
    try {
      const store = new FuturesStore(path)
      createRun(store)
      const runner = new FuturesCommandRunner(store)
      const accepted = runner.accept(command)
      expect(accepted.acknowledgement.type).toBe('command.ack')
      expect(accepted.acknowledgement.status).toBe('accepted')
      expect(store.loadPendingCommands()).toHaveLength(1)
      const result = await accepted.result
      expect(result.type).toBe('command.result')
      expect(store.getAppliedReceipt(command.work_id)?.status).toBe('committed')
      expect(store.exportRun(command.run_id).events).toHaveLength(4)
      expect(store.verifyRun(command.run_id)).toBe(true)
      const next = runner.accept(
        request('worker-request-2', 'worker-work-2', 1),
      )
      await next.result
      expect(
        (
          store.exportRun(command.run_id).projection as {
            result: { realized_net_complete: string }
          }
        ).result.realized_net_complete,
      ).toBe('0.1979')
      expect(store.exportRun(command.run_id).events).toHaveLength(8)
      await runner.close()
      store.close()

      const reopened = new FuturesStore(path)
      const restarted = new FuturesCommandRunner(reopened)
      const replay = restarted.accept(command)
      expect(replay.acknowledgement).toEqual(accepted.acknowledgement)
      expect(await replay.result).toEqual(result)
      expect(reopened.exportRun(command.run_id).events).toHaveLength(8)
      expect(reopened.loadPendingCommands()).toEqual([])
      await restarted.close()
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('sends no committed worker acknowledgement before result transaction and resumes accepted work after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-worker-restart-'))
    const path = join(directory, 'fixture.sqlite')
    const command = request()
    try {
      const store = new FuturesStore(path)
      createRun(store)
      const apply = store.applyResult.bind(store)
      vi.spyOn(store, 'applyResult').mockImplementation((value) =>
        apply(value, 'before-commit'),
      )
      const runner = new FuturesCommandRunner(store)
      const accepted = runner.accept(command)
      expect(accepted.acknowledgement.status).toBe('accepted')
      await expect(accepted.result).rejects.toThrow(
        'Injected pre-commit failure.',
      )
      expect(store.exportRun(command.run_id).events).toEqual([])
      expect(store.getAppliedReceipt(command.work_id)).toBeUndefined()
      expect(store.loadPendingCommands()).toHaveLength(1)
      await runner.close()
      store.close()

      const reopened = new FuturesStore(path)
      const restarted = new FuturesCommandRunner(reopened)
      const receipts = await restarted.resumePending()
      expect(receipts).toHaveLength(1)
      expect(receipts[0]?.type).toBe('command.result')
      expect(reopened.exportRun(command.run_id).events).toHaveLength(4)
      expect(reopened.loadPendingCommands()).toEqual([])
      await restarted.close()
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reconciles a lost post-commit worker acknowledgement from the exact stored receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-worker-ack-loss-'))
    const path = join(directory, 'fixture.sqlite')
    const command = request()
    try {
      const store = new FuturesStore(path)
      createRun(store)
      const apply = store.applyResult.bind(store)
      vi.spyOn(store, 'applyResult').mockImplementation((value) => {
        const receipt = apply(value)
        throw new Error(
          `Simulated ACK loss after commit: ${String(receipt.result_hash)}`,
        )
      })
      const runner = new FuturesCommandRunner(store)
      const accepted = runner.accept(command)
      await expect(accepted.result).rejects.toThrow(
        'Simulated ACK loss after commit',
      )
      const committed = store.getAppliedReceipt(command.work_id)
      expect(committed?.status).toBe('committed')
      expect(store.exportRun(command.run_id).events).toHaveLength(4)
      expect(store.loadPendingCommands()).toHaveLength(1)
      await runner.close()
      store.close()

      const reopened = new FuturesStore(path)
      const restarted = new FuturesCommandRunner(reopened)
      const replayed = await restarted.resumePending()
      expect(replayed).toHaveLength(1)
      expect(replayed[0]?.result).toEqual(committed)
      expect(reopened.getCommandResult(command.work_id)?.result).toEqual(
        committed,
      )
      expect(reopened.exportRun(command.run_id).events).toHaveLength(4)
      expect(reopened.loadPendingCommands()).toEqual([])
      await restarted.close()
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('resumes a durable queued command from the Node-owned persisted ledger checkpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-worker-checkpoint-'))
    const path = join(directory, 'fixture.sqlite')
    try {
      const store = new FuturesStore(path)
      createRun(store)
      const runner = new FuturesCommandRunner(store)
      const first = runner.accept(request())
      await first.result
      const nextCommand = request(
        'checkpoint-request-2',
        'checkpoint-work-2',
        1,
      )
      const checkpoint =
        store.getRunProjection(nextCommand.run_id)?.result ?? null
      expect(
        (checkpoint as { realized_net_complete: string }).realized_net_complete,
      ).toBe('0.09895')
      store.acceptCommand(
        nextCommand.work_id,
        nextCommand,
        undefined,
        checkpoint,
      )
      await runner.close()
      store.close()

      const reopened = new FuturesStore(path)
      const restarted = new FuturesCommandRunner(reopened)
      const results = await restarted.resumePending()
      expect(results).toHaveLength(1)
      expect(reopened.exportRun(nextCommand.run_id).events).toHaveLength(8)
      expect(
        (
          reopened.exportRun(nextCommand.run_id).projection as {
            result: { realized_net_complete: string }
          }
        ).result.realized_net_complete,
      ).toBe('0.1979')
      await restarted.close()
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function createRun(store: FuturesStore): void {
  store.createRun({
    runId: 'worker-run',
    config: {
      ledger_version: 'linear-usd-ledger.v1',
      decimal_precision: 50,
      leverage: '1',
    },
    seed: { cash_usd: '1000' },
    instrument: { instrument_id: 'kraken-futures:PF_XBTUSD' },
    costs: {
      version: 'kraken-futures-eea-btcusd-base.v1',
      maker: '0.0002',
      taker: '0.0005',
    },
  })
}

function request(
  requestId = 'worker-request',
  workId = 'worker-work',
  expectedStateVersion = 0,
): FuturesWorkerRequest {
  return {
    request_id: requestId,
    run_id: 'worker-run',
    work_id: workId,
    expected_state_version: expectedStateVersion,
    payload: {
      operation: 'round_trip',
      cash_usd: '1000',
      side: 'long',
      quantity_btc: '0.01',
      entry_price: '100',
      exit_price: '110',
    },
  }
}
