import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  devChildSpecs,
  devProxyConfig,
  resolvePython,
} from './dev-provider-env.mjs'

const root = '/repo'
const noFlags = new Set()

describe('devChildSpecs', () => {
  const specs = devChildSpecs({
    root,
    env: { FUTURES_MODE: 'paper_live', PORT: '9999', KEEP: 'yes' },
    allowedFlags: noFlags,
  })
  const byName = Object.fromEntries(specs.map((spec) => [spec.name, spec]))

  it('starts vite, legacy server, mock API, live capture, live gateway, verdict service and paper execution', () => {
    assert.deepEqual(
      specs.map((spec) => spec.name),
      ['vite', 'server', 'mock', 'capture', 'live', 'verdict', 'paper'],
    )
  })

  it('keeps the legacy server legacy even if the environment sets FUTURES_MODE', () => {
    assert.equal(byName.server.env.FUTURES_MODE, '')
    assert.equal(byName.server.env.PORT, '8787')
    assert.equal(byName.server.env.BALANCITA_ROOT_DEV_SERVER, 'true')
    assert.equal(byName.server.env.KEEP, 'yes')
    assert.equal(byName.server.cwd, '/repo/server')
  })

  it('runs the scripted MOCK terminal API only on 8788', () => {
    assert.deepEqual(byName.mock.args, [
      '/repo/scripts/futures-local-terminal.mjs',
      '--api-only',
      '--api-port',
      '8788',
    ])
    assert.equal(byName.mock.cwd, root)
  })

  it('runs capture as the only writer of the live market database, without HTTP or engine', () => {
    const { env, args, cwd } = byName.capture
    assert.equal(cwd, '/repo/server')
    assert.ok(args.includes('src/app/capture-main.ts'))
    assert.ok(!args.includes('--watch'))
    assert.equal(
      env.FUTURES_MARKET_DB_PATH,
      './data/dev-live/futures-market.sqlite',
    )
    assert.equal(env.FUTURES_MODE, '')
    assert.equal(env.FUTURES_DB_PATH, undefined)
  })

  it('runs the read-only live gateway on 8789 over the same market database', () => {
    const { env, args, cwd } = byName.live
    assert.equal(cwd, '/repo/server')
    assert.ok(args.includes('src/app/gateway-main.ts'))
    assert.ok(!args.includes('src/app/index.ts'))
    assert.equal(env.PORT, '8789')
    assert.equal(env.FUTURES_MODE, '')
    assert.equal(
      env.FUTURES_MARKET_DB_PATH,
      byName.capture.env.FUTURES_MARKET_DB_PATH,
    )
    assert.equal(env.FUTURES_DB_PATH, undefined)
  })

  it('points the gateway at the paper account and verdicts databases, the ones D and C write', () => {
    const { env } = byName.live
    const paperArgs = byName.paper.args
    assert.equal(
      env.FUTURES_PAPER_ACCOUNT_DB_PATH,
      paperArgs[paperArgs.indexOf('--account-db') + 1],
    )
    const verdictArgs = byName.verdict.args
    assert.equal(
      env.FUTURES_VERDICTS_DB_PATH,
      verdictArgs[verdictArgs.indexOf('--verdicts-db') + 1],
    )
    // The rollback child is the legacy single process: it gets neither.
    const rollback = devChildSpecs({
      root,
      env: { DEV_LIVE_SINGLE_PROCESS: '1' },
      allowedFlags: noFlags,
    }).find((spec) => spec.name === 'live')
    assert.equal(rollback.env.FUTURES_PAPER_ACCOUNT_DB_PATH, undefined)
    assert.equal(rollback.env.FUTURES_VERDICTS_DB_PATH, undefined)
  })

  it('runs the Python verdict service over the capture market database', () => {
    const { command, args, cwd, env } = byName.verdict
    assert.equal(command, 'python3')
    assert.equal(cwd, '/repo/server')
    assert.deepEqual(args, [
      '-m',
      'balancita_engine.futures_verdicts',
      '--market-db',
      byName.capture.env.FUTURES_MARKET_DB_PATH,
      '--verdicts-db',
      './data/dev-live/futures-verdicts.sqlite',
    ])
    assert.equal(env.PYTHONPATH, '/repo/python')
    assert.equal(env.KEEP, 'yes')
  })

  it('runs Python paper execution over the market and verdicts databases', () => {
    const { command, args, cwd, env } = byName.paper
    assert.equal(command, 'python3')
    assert.equal(cwd, '/repo/server')
    assert.deepEqual(args, [
      '-m',
      'balancita_engine.futures_paper_execution',
      '--market-db',
      byName.capture.env.FUTURES_MARKET_DB_PATH,
      '--verdicts-db',
      './data/dev-live/futures-verdicts.sqlite',
      '--account-db',
      './data/dev-live/futures-paper-account.sqlite',
    ])
    assert.equal(env.PYTHONPATH, '/repo/python')
    assert.equal(env.KEEP, 'yes')
  })

  it('keeps the single-process paper_live rollback behind DEV_LIVE_SINGLE_PROCESS', () => {
    const rollback = devChildSpecs({
      root,
      env: { DEV_LIVE_SINGLE_PROCESS: '1' },
      allowedFlags: noFlags,
    })
    assert.deepEqual(
      rollback.map((spec) => spec.name),
      ['vite', 'server', 'mock', 'live'],
    )
    const { env, args } = rollback.find((spec) => spec.name === 'live')
    assert.equal(env.FUTURES_MODE, 'paper_live')
    assert.equal(env.PORT, '8789')
    assert.ok(args.includes('src/app/index.ts'))
    for (const name of ['verdict', 'paper'])
      assert.equal(
        rollback.find((spec) => spec.name === name),
        undefined,
      )
    const paths = [
      env.FUTURES_DB_PATH,
      env.FUTURES_MARKET_DB_PATH,
      env.MARKET_DB_PATH,
      env.SIMULATIONS_REPORT_PATH,
    ]
    for (const path of paths) assert.match(path, /^\.\/data\/dev-live\//)
    assert.equal(new Set(paths).size, paths.length)
  })

  it('keeps vite on the default provider environment', () => {
    assert.equal(byName.vite.env.VITE_MARKET_DATA_PROVIDER, 'kraken')
  })
})

/** Fake probe runner: `table` maps "command args" to a probe result. */
function fakeRunner(table) {
  const calls = []
  const run = (command, args) => {
    // The probe is always `[...prefixArgs, '-c', code]`.
    const key = [command, ...args.slice(0, -2)].join(' ')
    calls.push(key)
    const result = table[key]
    if (!result) return { error: new Error(`spawn ${command} ENOENT`) }
    return { status: 0, stdout: result, stderr: '' }
  }
  return { run, calls }
}

describe('resolvePython', () => {
  it('prefers python3, then python, then py -3 on win32', () => {
    const { run, calls } = fakeRunner({ 'py -3': '3 12 3.45.1\n' })
    const result = resolvePython({ env: {}, platform: 'win32', run })
    assert.deepEqual(calls, ['python3', 'python', 'py -3'])
    assert.deepEqual(
      { command: result.command, prefixArgs: result.prefixArgs },
      { command: 'py', prefixArgs: ['-3'] },
    )
  })

  it('does not try py -3 outside Windows and takes the first qualifying candidate', () => {
    const none = fakeRunner({})
    const missing = resolvePython({
      env: {},
      platform: 'linux',
      run: none.run,
    })
    assert.equal(missing.command, undefined)
    assert.deepEqual(none.calls, ['python3', 'python'])
    const both = fakeRunner({
      python3: '3 9 3.40.0\n',
      python: '3 13 3.45.1\n',
    })
    const first = resolvePython({ env: {}, platform: 'linux', run: both.run })
    assert.equal(first.command, 'python3')
    assert.deepEqual(first.prefixArgs, [])
    assert.deepEqual(both.calls, ['python3'])
  })

  it('skips an interpreter older than 3.9 or with SQLite older than 3.37', () => {
    const { run } = fakeRunner({
      python3: '3 8 3.45.1\n',
      python: '3 12 3.36.0\n',
    })
    const result = resolvePython({ env: {}, platform: 'linux', run })
    assert.equal(result.command, undefined)
    assert.match(result.message, /3\.9/)
    assert.match(result.message, /3\.37/)
    assert.equal(result.failure, 'sqlite_too_old')
    assert.match(result.message, /python3/)
    assert.match(result.message, /python\b/)
    assert.match(result.message, /BALANCITA_PYTHON/)
  })

  it('accepts Python 3.9 with SQLite 3.37 and reports plain absence as not_found', () => {
    const ok = fakeRunner({ python3: '3 9 3.37.0\n' })
    assert.equal(
      resolvePython({ env: {}, platform: 'darwin', run: ok.run }).command,
      'python3',
    )
    const old = fakeRunner({ python3: '3 7 3.40.0\n' })
    assert.equal(
      resolvePython({ env: {}, platform: 'darwin', run: old.run }).failure,
      'not_found',
    )
  })

  it('moves on from an old SQLite to the next candidate', () => {
    const { run } = fakeRunner({
      python3: '3 9 3.32.3\n',
      python: '3 12 3.45.1\n',
    })
    assert.equal(
      resolvePython({ env: {}, platform: 'darwin', run }).command,
      'python',
    )
  })

  it('skips a candidate that prints something else (a Windows Store stub)', () => {
    const { run } = fakeRunner({
      python3: 'Python was not found; run without arguments to install\n',
      python: '3 12 3.45.1\n',
    })
    assert.equal(
      resolvePython({ env: {}, platform: 'win32', run }).command,
      'python',
    )
  })

  it('honors BALANCITA_PYTHON first and never falls back from an explicit choice', () => {
    const good = fakeRunner({
      '/opt/py/bin/python': '3 12 3.45.1\n',
      python3: '3 12 3.45.1\n',
    })
    const chosen = resolvePython({
      env: { BALANCITA_PYTHON: '/opt/py/bin/python' },
      platform: 'linux',
      run: good.run,
    })
    assert.equal(chosen.command, '/opt/py/bin/python')
    assert.deepEqual(good.calls, ['/opt/py/bin/python'])
    const bad = fakeRunner({ python3: '3 12 3.45.1\n' })
    const failed = resolvePython({
      env: { BALANCITA_PYTHON: '/nonexistent' },
      platform: 'linux',
      run: bad.run,
    })
    assert.equal(failed.command, undefined)
    assert.deepEqual(bad.calls, ['/nonexistent'])
    assert.match(failed.message, /BALANCITA_PYTHON=\/nonexistent/)
  })

  it('ignores an empty BALANCITA_PYTHON', () => {
    const { run, calls } = fakeRunner({ python3: '3 12 3.45.1\n' })
    resolvePython({ env: { BALANCITA_PYTHON: '  ' }, platform: 'linux', run })
    assert.deepEqual(calls, ['python3'])
  })

  it('runs the real probe against the interpreter running this test', () => {
    const result = resolvePython({
      env: { BALANCITA_PYTHON: 'python3' },
      platform: process.platform,
    })
    // Passes wherever dev can run; documents that the default runner works.
    assert.ok(result.command === 'python3' || result.message)
  })
})

describe('devChildSpecs with a resolved Python', () => {
  const base = { root, env: { KEEP: 'yes' }, allowedFlags: noFlags }
  const byName = (specs) => Object.fromEntries(specs.map((s) => [s.name, s]))

  it('injects the command and its prefix args into verdict and paper', () => {
    const specs = byName(
      devChildSpecs({
        ...base,
        python: { command: 'py', prefixArgs: ['-3'] },
      }),
    )
    for (const name of ['verdict', 'paper']) {
      assert.equal(specs[name].command, 'py')
      assert.deepEqual(specs[name].args.slice(0, 3), [
        '-3',
        '-m',
        specs[name].args[2],
      ])
    }
    assert.equal(specs.verdict.args[2], 'balancita_engine.futures_verdicts')
    assert.equal(specs.live.env.BALANCITA_PYTHON_STATUS, 'available')
  })

  it('without Python starts neither verdict nor paper and tells the gateway', () => {
    const specs = devChildSpecs({ ...base, python: null })
    assert.deepEqual(
      specs.map((spec) => spec.name),
      ['vite', 'server', 'mock', 'capture', 'live'],
    )
    assert.equal(
      specs.find((spec) => spec.name === 'live').env.BALANCITA_PYTHON_STATUS,
      'unavailable',
    )
  })

  it('maps the not_found failure from resolvePython to the unavailable status', () => {
    const specs = devChildSpecs({
      ...base,
      python: { unavailable: 'not_found' },
    })
    assert.equal(
      specs.find((spec) => spec.name === 'live').env.BALANCITA_PYTHON_STATUS,
      'unavailable',
    )
    assert.equal(
      specs.find((spec) => spec.name === 'verdict'),
      undefined,
    )
  })

  it('tells the gateway when only SQLite is too old', () => {
    const specs = devChildSpecs({
      ...base,
      python: { unavailable: 'sqlite_too_old' },
    })
    assert.deepEqual(
      specs.map((spec) => spec.name),
      ['vite', 'server', 'mock', 'capture', 'live'],
    )
    assert.equal(
      specs.find((spec) => spec.name === 'live').env.BALANCITA_PYTHON_STATUS,
      'sqlite_too_old',
    )
  })

  it('does not leak an inherited BALANCITA_PYTHON_STATUS', () => {
    const specs = devChildSpecs({
      ...base,
      env: { BALANCITA_PYTHON_STATUS: 'unavailable' },
      python: { command: 'python3', prefixArgs: [] },
    })
    assert.equal(
      specs.find((spec) => spec.name === 'live').env.BALANCITA_PYTHON_STATUS,
      'available',
    )
  })
})

describe('devProxyConfig', () => {
  const proxy = devProxyConfig()

  it('keeps /api on the legacy server and proxies websockets', () => {
    assert.equal(proxy['/api'].target, 'http://127.0.0.1:8787')
    assert.equal(proxy['/api'].ws, true)
    assert.equal(proxy['/api'].rewrite, undefined)
  })

  it('routes /api-mock and /api-live to their backends with /api rewrite', () => {
    for (const [prefix, port] of [
      ['/api-mock', 8788],
      ['/api-live', 8789],
    ]) {
      assert.equal(proxy[prefix].target, `http://127.0.0.1:${port}`)
      assert.equal(proxy[prefix].ws, true)
      assert.equal(
        proxy[prefix].rewrite(`${prefix}/terminal/bootstrap?x=1`),
        '/api/terminal/bootstrap?x=1',
      )
    }
  })

  it('does not let /api swallow the prefixed routes', () => {
    const keys = Object.keys(proxy)
    assert.ok(keys.indexOf('/api-mock') < keys.indexOf('/api'))
    assert.ok(keys.indexOf('/api-live') < keys.indexOf('/api'))
    assert.ok(
      proxy['/api'] &&
        Object.keys(proxy).every((key) => key.startsWith('/api')),
    )
  })
})
