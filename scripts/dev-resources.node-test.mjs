import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePs, readPs, summarizeResources } from './dev-resources.mjs'
import * as resources from './dev-resources.mjs'

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

  it('counts each PID once in totals despite group aliases and Kronos overlap', () => {
    const body = summarizeResources({
      rows: parsePs(PS),
      groups: { first: 100, alias: 100, kronosGroup: 1 },
      kronosPattern: /kronos_lab/g,
    })
    assert.equal(body.total_cpu_pct, 8)
    assert.equal(body.total_rss_mb, 80)
    assert.equal(body.processes.alias.cpu_pct, 4)
    assert.equal(body.kronos.cpu_pct, 4)
    assert.deepEqual(body.group_pid_counts, { first: 2, alias: 2, kronosGroup: 1 })
    assert.equal(body.total_pid_count, 3)
  })

  it('rejects malformed nonblank ps records instead of silently losing them', () => {
    for (const line of ['not a ps row', '1 1 1..2 100 node', '-1 1 0 0 node'])
      assert.throws(() => parsePs(`${PS}${line}\n`))
    assert.deepEqual(parsePs(' \n'), [])
  })

  it('reports Kronos as not running when nothing matches', () => {
    const body = summarizeResources({
      rows: parsePs('  1  1  0.0  10 init\n'),
      groups: {},
    })
    assert.equal(body.kronos.running, false)
  })

  it('bounds ps collection and distinguishes command failures from empty output', async () => {
    const failures = [
      [new Error('private command'), 'collector_error'],
      [Object.assign(new Error('private command'), { killed: true }), 'timeout'],
    ]
    for (const [error, reason] of failures) {
      const sample = await readPs({
        exec: (_file, _args, options, callback) => {
          assert.equal(options.timeout, 2000)
          callback(error, PS)
        },
      })
      assert.deepEqual(sample, { status: 'unavailable', reason })
    }
    for (const [text, expected] of [
      ['', { status: 'ok', rows: [] }],
      [PS, { status: 'ok', rows: parsePs(PS) }],
      ['invalid', { status: 'unavailable', reason: 'malformed_output' }],
    ]) {
      const sample = await readPs({
        exec: (_file, _args, _options, callback) => callback(null, text),
      })
      assert.deepEqual(sample, expected)
    }
  })

  it('retains one-core CPU above 100 percent without exposing unrelated rows', () => {
    const body = summarizeResources({
      rows: parsePs('0 0 0.0 0 kernel\n100 100 250,5 1024 node\n900 900 999 100000 unrelated\n'),
      groups: { vite: 100, absent: 999 }, cores: 8,
    })
    assert.equal(body.total_cpu_pct, 250.5)
    assert.equal(body.total_rss_mb, 1)
    assert.equal(body.group_pid_counts.absent, 0)
    assert.equal(body.total_pid_count, 1)
    assert.ok(!JSON.stringify(body).includes('unrelated'))
  })

  it('publishes unavailable, not measured zeros, on failed collectors', async () => {
    for (const collect of [
      async () => { throw new Error('secret command and env') },
      async () => ({ status: 'unavailable', reason: 'timeout' }),
      async () => ({ status: 'unavailable', reason: 'secret command and env' }),
    ]) {
      let time = 10
      const body = await resources.collectResources({
        collect, groups: { vite: 100 }, clock: () => time++, cores: 8,
      })
      assert.equal(body.status, 'unavailable')
      assert.ok(['timeout', 'collector_error'].includes(body.reason))
      assert.equal(body.attempted_at_ms, 10)
      assert.equal(body.completed_at_ms, 11)
      assert.equal(body.sampled_at_ms, null)
      assert.equal(body.total_cpu_pct, null)
      assert.equal(body.total_rss_mb, null)
      assert.deepEqual(body.processes.vite, { cpu_pct: null, rss_mb: null })
      assert.equal(body.kronos, null) // Legacy endpoint must not coerce unknown running to false.
      assert.ok(!JSON.stringify(body).includes('secret'))
    }
  })

  it('keeps successful empty and measured zero samples distinct from failure', async () => {
    for (const rows of [[], parsePs('100 100 0.0 0 node private-argument\n')]) {
      const body = await resources.collectResources({
        collect: async () => ({ status: 'ok', rows }),
        groups: { vite: 100 }, clock: () => 20, cores: 8,
      })
      assert.equal(body.status, 'ok')
      assert.equal(body.reason, null)
      assert.equal(body.sampled_at_ms, 20)
      assert.equal(body.total_cpu_pct, 0)
      assert.equal(body.total_rss_mb, 0)
      assert.equal(body.group_pid_counts.vite, rows.length)
      assert.equal(body.total_pid_count, rows.length)
      assert.equal(body.cpu_basis, 'one_core_percent')
      assert.equal(body.memory_basis, 'summed_rss_mib_not_unique_or_gpu')
      assert.ok(!JSON.stringify(body).includes('private-argument'))
    }
  })

  it('rejects invalid envelopes and duplicate PID rows without publishing partial totals', async () => {
    const rows = parsePs(PS)
    for (const sample of [null, [], { status: 'ok' }, { status: 'unknown' },
      { status: 'ok', rows: [...rows, rows[0]] }]) {
      const body = await resources.collectResources({
        collect: async () => sample, groups: {}, clock: () => 42,
      })
      assert.equal(body.status, 'unavailable')
      assert.equal(body.reason, 'malformed_output')
      assert.equal(body.total_rss_mb, null)
      assert.equal(body.sampled_at_ms, null)
    }
  })

  it('makes malformed injected rows unavailable, including partial invalid samples', async () => {
    const valid = parsePs(PS)[0]
    const other = { ...valid, pid: 999 }
    const invalidRows = [
      null,
      { ...other, cpu: NaN },
      { ...other, cpu: -1 },
      { ...other, rssKb: Infinity },
      { ...other, rssKb: -1 },
      { ...other, pid: 1.5 },
      { ...other, pgid: -1 },
      { ...other, command: null },
    ]
    for (const bad of invalidRows) {
      const body = await resources.collectResources({
        collect: async () => ({ status: 'ok', rows: [valid, bad] }), groups: { vite: 100 },
      })
      assert.equal(body.status, 'unavailable')
      assert.equal(body.reason, 'malformed_output')
      assert.equal(body.total_cpu_pct, null)
    }
  })
})
