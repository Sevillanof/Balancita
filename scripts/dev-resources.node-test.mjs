import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePs, summarizeResources } from './dev-resources.mjs'

const PS = `  100   100   2.5  20480 node vite
  101   100   1.5  10240 node esbuild
  200   200  30.0 409600 llama-server -m model.gguf
  300     1   4.0  51200 python -m kronos_lab.lab --mode forward
  400   400   0.0   1024 sleep 1
`

describe('dev resources', () => {
  it('parses ps rows', () => {
    const rows = parsePs(PS)
    assert.equal(rows.length, 5)
    assert.deepEqual(rows[2], {
      pid: 200,
      pgid: 200,
      cpu: 30,
      rssKb: 409600,
      command: 'llama-server -m model.gguf',
    })
  })

  it('sums each process group and finds Kronos by its command', () => {
    const body = summarizeResources({
      rows: parsePs(PS),
      groups: { vite: 100, llm: 200, ghost: 999 },
      now: 5,
      cores: 8,
    })
    assert.deepEqual(body.processes.vite, { cpu_pct: 4, rss_mb: 30 })
    assert.deepEqual(body.processes.llm, { cpu_pct: 30, rss_mb: 400 })
    assert.deepEqual(body.processes.ghost, { cpu_pct: 0, rss_mb: 0 })
    assert.deepEqual(body.kronos, { running: true, cpu_pct: 4, rss_mb: 50 })
    assert.equal(body.total_cpu_pct, 38)
    assert.equal(body.cores, 8)
  })

  it('reports Kronos as not running when nothing matches', () => {
    const body = summarizeResources({
      rows: parsePs('  1  1  0.0  10 init\n'),
      groups: {},
    })
    assert.equal(body.kronos.running, false)
  })
})
