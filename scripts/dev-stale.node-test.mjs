import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isOurs, sweepStale } from './dev-stale.mjs'

const root = '/repo'

function fakeProbe({ procs, listeners = {} }) {
  const live = new Set(Object.keys(procs).map(Number))
  const signals = []
  return {
    signals,
    listeners: (port) => listeners[port] ?? [],
    info: (pid) => (live.has(pid) ? procs[pid] : undefined),
    alive: (pid) => live.has(pid),
    signal(pid, signal, group) {
      signals.push([pid, signal, group])
      live.delete(pid)
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
