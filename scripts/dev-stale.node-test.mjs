import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  devChildName,
  isOurs,
  parseEtime,
  sweepStale,
  systemProbe,
} from './dev-stale.mjs'

const root = '/repo'

function fakeProbe({ procs, listeners = {}, processes = [], ignoreTerm = [] }) {
  const live = new Set(Object.keys(procs).map(Number))
  const signals = []
  return {
    signals,
    listeners: (port) => listeners[port] ?? [],
    info: (pid) => (live.has(pid) ? procs[pid] : undefined),
    alive: (pid) => live.has(pid),
    processes: () => processes,
    signal(pid, signal, group) {
      signals.push([pid, signal, group])
      if (signal === 'SIGTERM' && ignoreTerm.includes(pid)) return
      live.delete(pid)
      // A group signal reaches every member of the group.
      if (group)
        for (const [other, info] of Object.entries(procs))
          if (info.pgid === pid) live.delete(Number(other))
    },
    sleep: async () => {},
  }
}

describe('isOurs', () => {
  it('matches by command line or cwd under the root', () => {
    assert.ok(isOurs({ command: `node ${root}/x.mjs` }, root))
    assert.ok(isOurs({ command: 'python3 -m x', cwd: `${root}/server` }, root))
    assert.ok(!isOurs({ command: 'node /other/x.mjs', cwd: '/repo2' }, root))
    assert.ok(!isOurs(undefined, root))
  })

  it('does not take a sibling checkout whose path starts the same', () => {
    assert.ok(!isOurs({ command: `node ${root}-old/x.mjs` }, root))
    assert.ok(!isOurs({ command: `node /x${root}/x.mjs` }, root))
    assert.ok(isOurs({ command: `node --env-file=${root}/.env x` }, root))
  })
})

describe('devChildName', () => {
  it('names each dev child and ignores look-alikes', () => {
    const py = (module) =>
      `/usr/bin/python3 -m balancita_engine.${module} --db x`
    assert.equal(devChildName(py('futures_forward')), 'forward')
    assert.equal(devChildName(py('futures_news')), 'news')
    assert.equal(devChildName(py('futures_qwen_live')), 'qwenlive')
    assert.equal(devChildName(py('futures_qwen_exit')), 'qwenexit')
    assert.equal(devChildName(py('futures_verdicts')), 'verdict')
    assert.equal(devChildName(py('futures_forecast_scores')), 'scores')
    assert.equal(devChildName(py('futures_carry')), 'carry')
    assert.equal(devChildName(py('futures_strategy_registry')), 'strategies')
    assert.equal(devChildName(py('futures_llm_decisions')), 'q')
    assert.equal(
      devChildName(
        'node --use-system-ca --experimental-strip-types src/app/capture-main.ts',
      ),
      'capture',
    )
    assert.equal(
      devChildName(
        'node --experimental-strip-types src/features/positioning-collector/collector-main.ts',
      ),
      'positioning',
    )
    assert.equal(
      devChildName(
        'node --experimental-strip-types --watch src/app/gateway-main.ts',
      ),
      'live',
    )
    assert.equal(
      devChildName('node /repo/node_modules/vite/bin/vite.js'),
      'vite',
    )
    assert.equal(devChildName('llama-server -m model.gguf --port 8088'), 'llm')
    assert.equal(
      devChildName('taskpolicy -b llama-server -m model.gguf'),
      'llm',
    )
    assert.equal(devChildName('grep futures_forward /repo/log'), undefined)
    assert.equal(
      devChildName('vim /repo/server/src/app/capture-main.ts'),
      undefined,
    )
    assert.equal(devChildName('python3 -m http.server'), undefined)
  })
})

describe('parseEtime', () => {
  it('reads ps elapsed times', () => {
    assert.equal(parseEtime('05:07'), 307)
    assert.equal(parseEtime('02:03:04'), 7384)
    assert.equal(parseEtime('1-00:00:01'), 86401)
    assert.equal(parseEtime('nope'), undefined)
  })
})

describe('sweepStale', () => {
  const base = {
    root,
    liveDir: '/repo/server/data/dev-live',
    ports: [{ name: 'strategies', port: 8790 }],
    listDir: () => ['futures-market.sqlite.writer.lock', 'other.txt'],
  }

  it('stops leftovers of this checkout holding a port or a lock', async () => {
    const probe = fakeProbe({
      procs: {
        10: { pgid: 10, command: 'python3 -m x', cwd: '/repo/python' },
        11: { pgid: 11, command: 'node capture-main.ts', cwd: '/repo/server' },
      },
      listeners: { 8790: [10] },
    })
    const readFile = (path) =>
      path.endsWith('.writer.lock') ? JSON.stringify({ pid: 11 }) : ''
    const result = await sweepStale({ ...base, probe, readFile, selfPid: 1 })
    assert.equal(result.blockers.length, 0)
    assert.equal(result.stopped.length, 2)
    assert.deepEqual(probe.signals[0], [11, 'SIGTERM', true])
  })

  it('reports a foreign holder and leaves it running', async () => {
    const probe = fakeProbe({
      procs: { 20: { pgid: 20, command: 'nginx', cwd: '/' } },
      listeners: { 8790: [20] },
    })
    const result = await sweepStale({
      ...base,
      listDir: () => [],
      probe,
      selfPid: 1,
    })
    assert.equal(probe.signals.length, 0)
    assert.match(result.blockers[0], /port 8790 \(strategies\).*pid 20/)
  })

  it('never touches itself', async () => {
    const probe = fakeProbe({
      procs: { 1: { pgid: 1, command: `node ${root}/scripts/dev.mjs` } },
      listeners: { 8790: [1] },
    })
    const result = await sweepStale({
      ...base,
      listDir: () => [],
      probe,
      selfPid: 1,
    })
    assert.equal(probe.signals.length, 0)
    assert.equal(result.stopped.length, 0)
  })
})

describe('sweepStale: leftover dev children', () => {
  const base = {
    root,
    liveDir: '/repo/server/data/dev-live',
    ports: [],
    listDir: () => [],
    selfPid: 1,
  }
  const forward = (extra = {}) => ({
    pgid: 50,
    elapsedSec: 5 * 3600,
    command: `/usr/bin/python3 -m balancita_engine.futures_forward --out ${root}/server/data/f`,
    ...extra,
  })

  it('stops an orphaned forward of this repo and says how long it ran', async () => {
    const orphan = { pid: 50, ...forward() }
    const probe = fakeProbe({
      procs: { 50: orphan },
      processes: [orphan],
    })
    const result = await sweepStale({ ...base, probe })
    assert.deepEqual(probe.signals, [[50, 'SIGTERM', true]])
    assert.equal(result.blockers.length, 0)
    assert.match(result.stopped[0], /pid 50 \(forward, running 5h\)/)
  })

  it('stops a news found by its cwd when the command has no root', async () => {
    const news = {
      pid: 60,
      pgid: 60,
      command: 'python3 -m balancita_engine.futures_news --news-db ./data/n',
    }
    const probe = fakeProbe({
      procs: { 60: { ...news, cwd: `${root}/server` } },
      processes: [news],
    })
    const result = await sweepStale({ ...base, probe })
    assert.deepEqual(probe.signals, [[60, 'SIGTERM', true]])
    assert.match(result.stopped[0], /pid 60 \(news\)/)
  })

  it('leaves the forward of another checkout alone and does not mention it', async () => {
    const other = {
      pid: 70,
      pgid: 70,
      command: 'python3 -m balancita_engine.futures_forward --out ./x',
    }
    const sibling = {
      pid: 71,
      pgid: 71,
      command: `python3 -m balancita_engine.futures_forward --out ${root}-old/x`,
    }
    const probe = fakeProbe({
      procs: {
        70: { ...other, cwd: '/otro/repo/server' },
        71: { ...sibling, cwd: `${root}-old/server` },
      },
      processes: [other, sibling],
    })
    const result = await sweepStale({ ...base, probe })
    assert.equal(probe.signals.length, 0)
    assert.deepEqual(result, { stopped: [], blockers: [] })
  })

  it('never touches its own pid or its process group', async () => {
    const self = {
      pid: 1,
      pgid: 1,
      command: `node ${root}/scripts/dev.mjs`,
    }
    const sameGroup = forward({ pid: 2, pgid: 1 })
    const probe = fakeProbe({
      procs: { 1: self, 2: sameGroup },
      processes: [self, { pid: 2, ...sameGroup }],
    })
    const result = await sweepStale({ ...base, probe })
    assert.equal(probe.signals.length, 0)
    assert.equal(result.stopped.length, 0)
  })

  it('sends SIGKILL to what survives SIGTERM and reports it', async () => {
    const stubborn = { pid: 80, ...forward({ pgid: 80 }) }
    const probe = fakeProbe({
      procs: { 80: stubborn },
      processes: [stubborn],
      ignoreTerm: [80],
    })
    const result = await sweepStale({ ...base, probe, graceMs: 0 })
    assert.deepEqual(
      probe.signals.map(([, signal]) => signal),
      ['SIGTERM', 'SIGKILL'],
    )
    assert.match(result.stopped[0], /pid 80 \(forward/)
  })

  it('does not stop a pid twice and takes group leaders first', async () => {
    const leader = {
      pid: 90,
      pgid: 90,
      command: `node ${root}/node_modules/vite/bin/vite.js`,
    }
    const member = { pid: 91, pgid: 90, command: leader.command }
    const probe = fakeProbe({
      procs: { 90: leader, 91: member },
      processes: [member, leader],
      listeners: { 5173: [90] },
    })
    const result = await sweepStale({
      ...base,
      ports: [{ name: 'vite', port: 5173 }],
      probe,
    })
    assert.equal(result.stopped.length, 1)
    assert.deepEqual(probe.signals, [[90, 'SIGTERM', true]])
  })

  it('does not look at processes on win32', async () => {
    let asked = false
    const probe = {
      ...fakeProbe({ procs: {} }),
      processes: () => {
        asked = true
        return []
      },
    }
    const result = await sweepStale({ ...base, probe, platform: 'win32' })
    assert.equal(asked, false)
    assert.deepEqual(result, { stopped: [], blockers: [] })
    assert.deepEqual(systemProbe.processes('win32'), [])
  })
})

describe('config-mismatch rotation', () => {
  it('maps the refusal text to the DB and renames it with its WAL files', async () => {
    const { mismatchedDb, rotateDb } = await import('./dev-stale.mjs')
    assert.equal(
      mismatchedDb(
        'ValueError: forecast scores DB was written with a different config; use a new DB',
      ),
      'futures-forecast-scores',
    )
    assert.equal(mismatchedDb('some other error'), undefined)
    const moves = []
    const backup = rotateDb(
      '/d',
      'futures-verdicts',
      new Date('2026-10-07T12:00:00Z'),
      (from, to) => moves.push([from, to]),
    )
    assert.equal(backup, 'futures-verdicts.sqlite.old-20261007T120000')
    assert.equal(moves.length, 3)
  })
})
