import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import {
  checkDevPorts,
  describeChildExit,
  devChildSpecs,
  devProxyConfig,
  findQwenModel,
  llamaPort,
  loadDevEnv,
  planStartup,
  resolveLlamaModel,
  resolveLlamaServer,
  resolvePython,
  signalChild,
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

  it('starts vite, legacy server, mock API, live capture, live gateway, verdict service, paper execution, forecast scorer, strategy registry and news', () => {
    assert.deepEqual(
      specs.map((spec) => spec.name),
      [
        'vite',
        'server',
        'mock',
        'capture',
        'live',
        'verdict',
        'paper',
        'scores',
        'strategies',
        'news',
      ],
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
  })

  it('gives the gateway the decisions database and the Python for Qwen scores', () => {
    const { env } = byName.live
    assert.match(
      env.FUTURES_DECISIONS_DB_PATH,
      /futures-llm-decisions\.sqlite$/,
    )
    assert.deepEqual(JSON.parse(env.BALANCITA_PYTHON_COMMAND), ['python3'])
    assert.ok(env.PYTHONPATH.split(delimiter).includes('/repo/python'))
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

  it('runs the Python forecast scorer over the market and verdicts databases into its own scores database', () => {
    const { command, args, cwd, env } = byName.scores
    assert.equal(command, 'python3')
    assert.equal(cwd, '/repo/server')
    assert.deepEqual(args, [
      '-m',
      'balancita_engine.futures_forecast_scores',
      '--market-db',
      byName.capture.env.FUTURES_MARKET_DB_PATH,
      '--verdicts-db',
      './data/dev-live/futures-verdicts.sqlite',
      '--scores-db',
      './data/dev-live/futures-forecast-scores.sqlite',
    ])
    assert.equal(env.PYTHONPATH, '/repo/python')
    assert.equal(env.KEEP, 'yes')
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

  it('injects the command and its prefix args into verdict, paper and scores', () => {
    const specs = byName(
      devChildSpecs({
        ...base,
        python: { command: 'py', prefixArgs: ['-3'] },
      }),
    )
    for (const name of ['verdict', 'paper', 'scores']) {
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

  it('without Python starts none of verdict, paper and scores and tells the gateway', () => {
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

describe('server/.env is optional', () => {
  const flag = '--env-file-if-exists=.env'
  const watched = ['server', 'capture', 'live']
  const specsWith = (exists, env = {}) =>
    devChildSpecs({ root, env, allowedFlags: noFlags, exists })

  it('omits the env-file flag when server/.env is missing (it crashes --watch)', () => {
    const seen = []
    const specs = specsWith((path) => (seen.push(path), false))
    assert.deepEqual(seen, ['/repo/server/.env'])
    for (const spec of specs.filter((s) => watched.includes(s.name)))
      assert.ok(!spec.args.includes(flag), spec.name)
  })

  it('adds the flag to the node children of server/ when the file exists', () => {
    const specs = specsWith(() => true)
    for (const spec of specs.filter((s) => watched.includes(s.name)))
      assert.equal(spec.args[0], flag, spec.name)
    assert.ok(!specs.find((s) => s.name === 'vite').args.includes(flag))
  })
})

describe('port checks before startup', () => {
  const taken =
    (...ports) =>
    async (port) =>
      !ports.includes(port)

  it('passes when every dev port is free and probes the right hosts', async () => {
    const calls = []
    const result = await checkDevPorts({
      probe: async (port, host) => (calls.push([port, host]), true),
    })
    assert.equal(result.ok, true)
    assert.deepEqual(calls, [
      [5173, 'localhost'],
      [8787, '127.0.0.1'],
      [8788, '127.0.0.1'],
      [8789, '127.0.0.1'],
    ])
  })

  it('names the port, the child and how to free it', async () => {
    const result = await checkDevPorts({ probe: taken(8789) })
    assert.equal(result.ok, false)
    assert.equal(result.conflicts.length, 1)
    const { message } = result.conflicts[0]
    assert.match(message, /8789/)
    assert.match(message, /live/)
    assert.match(message, /lsof -ti tcp:8789 \| xargs kill/)
  })

  it('reports every conflict', async () => {
    const result = await checkDevPorts({ probe: taken(5173, 8787) })
    assert.deepEqual(
      result.conflicts.map((c) => c.port),
      [5173, 8787],
    )
  })

  it('planStartup exits non-zero without starting on a conflict', async () => {
    const plan = await planStartup({ probe: taken(8789) })
    assert.equal(plan.start, false)
    assert.equal(plan.exitCode, 1)
    assert.equal(plan.messages.length, 1)
    assert.deepEqual(await planStartup({ probe: taken() }), {
      start: true,
      messages: [],
    })
  })

  it('the default probe sees a real listener', async () => {
    const { createServer } = await import('node:net')
    const holder = createServer()
    await new Promise((ok) => holder.listen(0, '127.0.0.1', ok))
    const { port } = holder.address()
    const { canListen } = await import('./dev-provider-env.mjs')
    assert.equal(await canListen(port, '127.0.0.1'), false)
    await new Promise((ok) => holder.close(ok))
    assert.equal(await canListen(port, '127.0.0.1'), true)
  })
})

describe('child exit and shutdown', () => {
  it('states that the browser may be talking to another process on EADDRINUSE', () => {
    const text = describeChildExit({
      name: 'live',
      code: 1,
      signal: null,
      sawAddrInUse: true,
    })
    assert.match(text, /EADDRINUSE/)
    assert.match(text, /8789/)
    assert.match(text, /browser may be talking to/)
    assert.doesNotMatch(
      describeChildExit({ name: 'live', code: 1, sawAddrInUse: false }),
      /EADDRINUSE/,
    )
  })

  it('signals the whole process group on POSIX', () => {
    const calls = []
    signalChild({ pid: 42, kill: () => calls.push('direct') }, 'SIGTERM', {
      platform: 'darwin',
      killGroup: (...a) => calls.push(a),
    })
    assert.deepEqual(calls, [[-42, 'SIGTERM']])
  })

  it('falls back to the direct kill when the group is gone, and on win32', () => {
    const calls = []
    const child = { pid: 42, kill: (s) => calls.push(['direct', s]) }
    signalChild(child, 'SIGKILL', {
      platform: 'linux',
      killGroup: () => {
        throw new Error('ESRCH')
      },
    })
    signalChild(child, 'SIGTERM', {
      platform: 'win32',
      killGroup: () => assert.fail('no group kill on win32'),
    })
    assert.deepEqual(calls, [
      ['direct', 'SIGKILL'],
      ['direct', 'SIGTERM'],
    ])
  })
})

describe('optional LLM decision children (llm and q)', () => {
  const base = {
    root,
    allowedFlags: noFlags,
    python: { command: 'python3', prefixArgs: [] },
  }
  const llm = { command: 'llama-server' }
  const local = { LLAMA_MODEL_PATH: '/models/q.gguf' }
  const byName = (specs) => Object.fromEntries(specs.map((s) => [s.name, s]))
  const names = (specs) => specs.map((s) => s.name)

  it('adds neither child unless llama-server was resolved', () => {
    for (const absent of [undefined, null, { unavailable: 'not_found' }])
      assert.ok(
        !names(devChildSpecs({ ...base, env: {}, llm: absent })).includes(
          'llm',
        ),
      )
    assert.ok(!names(devChildSpecs({ ...base, env: {} })).includes('q'))
  })

  it('starts neither llm nor q when no local model is known (never downloads)', () => {
    const specs = devChildSpecs({ ...base, env: {}, llm })
    assert.ok(!names(specs).includes('llm'))
    assert.ok(!names(specs).includes('q'))
    assert.ok(!specs.some((spec) => spec.args.includes('-hf')))
  })

  it('starts llm and q after the other children when enabled', () => {
    const specs = devChildSpecs({ ...base, env: local, llm })
    assert.deepEqual(names(specs).slice(-2), ['llm', 'q'])
    assert.ok(names(specs).indexOf('news') < names(specs).indexOf('llm'))
  })

  it('runs llama-server offline on loopback with the guide flags', () => {
    const { llm: spec } = byName(devChildSpecs({ ...base, env: local, llm }))
    assert.equal(spec.command, 'llama-server')
    assert.deepEqual(spec.args, [
      '-m',
      '/models/q.gguf',
      '--offline',
      '--host',
      '127.0.0.1',
      '--port',
      '8088',
      '-c',
      '8192',
      '-np',
      '2',
      '--no-mmproj',
      '--no-webui',
    ])
  })

  it('takes port, context, parallelism and model from the environment; a local path wins over LLAMA_HF', () => {
    const env = {
      LLAMA_PORT: '9001',
      LLAMA_CTX: '4096',
      LLAMA_PARALLEL: '3',
      LLAMA_MODEL_PATH: '/models/q.gguf',
      LLAMA_HF: 'org/other:Q6_K',
    }
    const { llm: spec } = byName(devChildSpecs({ ...base, env, llm }))
    assert.deepEqual(spec.args.slice(0, 2), ['-m', '/models/q.gguf'])
    assert.ok(!spec.args.includes('-hf'))
    assert.ok(spec.args.includes('--offline'))
    assert.equal(spec.args[spec.args.indexOf('--port') + 1], '9001')
    assert.equal(spec.args[spec.args.indexOf('-c') + 1], '4096')
    assert.equal(spec.args[spec.args.indexOf('-np') + 1], '3')
    const hf = byName(
      devChildSpecs({ ...base, env: { LLAMA_HF: 'org/other:Q6_K' }, llm }),
    )
    assert.deepEqual(hf.llm.args.slice(0, 3), [
      '-hf',
      'org/other:Q6_K',
      '--offline',
    ])
  })

  it('never exposes a tools or agent flag nor binds beyond loopback', () => {
    const { llm: spec } = byName(devChildSpecs({ ...base, env: local, llm }))
    assert.equal(spec.args[spec.args.indexOf('--host') + 1], '127.0.0.1')
    assert.ok(!spec.args.some((a) => /tools|agent/.test(a)))
  })

  it('runs Python process Q over the market and verdicts databases into its own decisions database', () => {
    const { q } = byName(
      devChildSpecs({ ...base, env: { ...local, KEEP: 'yes' }, llm }),
    )
    assert.equal(q.command, 'python3')
    assert.equal(q.cwd, '/repo/server')
    assert.deepEqual(q.args, [
      '-m',
      'balancita_engine.futures_llm_decisions',
      '--market-db',
      './data/dev-live/futures-market.sqlite',
      '--verdicts-db',
      './data/dev-live/futures-verdicts.sqlite',
      '--decisions-db',
      './data/dev-live/futures-llm-decisions.sqlite',
    ])
    assert.equal(q.env.PYTHONPATH, '/repo/python')
    assert.equal(q.env.KEEP, 'yes')
  })

  it('hands q the llama port so it follows LLAMA_PORT', () => {
    const { q } = byName(
      devChildSpecs({ ...base, env: { ...local, LLAMA_PORT: '9001' }, llm }),
    )
    assert.equal(q.env.LLAMA_PORT, '9001')
  })

  it('starts neither llm nor q without Python', () => {
    const specs = devChildSpecs({ ...base, env: local, llm, python: null })
    assert.ok(!names(specs).includes('llm'))
    assert.ok(!names(specs).includes('q'))
  })

  it('llamaPort defaults to 8088 and rejects junk', () => {
    assert.equal(llamaPort({}), 8088)
    assert.equal(llamaPort({ LLAMA_PORT: '9001' }), 9001)
    assert.equal(llamaPort({ LLAMA_PORT: 'abc' }), 8088)
  })
})

describe('optional news child (n)', () => {
  const base = {
    root,
    allowedFlags: noFlags,
    python: { command: 'python3', prefixArgs: [] },
  }
  const llm = { command: 'llama-server' }
  const local = { LLAMA_MODEL_PATH: '/models/q.gguf' }
  const byName = (specs) => Object.fromEntries(specs.map((s) => [s.name, s]))
  const names = (specs) => specs.map((s) => s.name)

  it('runs Python process N into its own news database, ingest only, without a model', () => {
    const { news } = byName(devChildSpecs({ ...base, env: { KEEP: 'yes' } }))
    assert.equal(news.command, 'python3')
    assert.equal(news.cwd, '/repo/server')
    assert.deepEqual(news.args, [
      '-m',
      'balancita_engine.futures_news',
      '--news-db',
      './data/dev-live/futures-news.sqlite',
    ])
    assert.equal(news.env.PYTHONPATH, '/repo/python')
    assert.equal(news.env.KEEP, 'yes')
  })

  it('uses the resolved Python command and its prefix args', () => {
    const { news } = byName(
      devChildSpecs({
        ...base,
        env: {},
        python: { command: 'py', prefixArgs: ['-3'] },
      }),
    )
    assert.equal(news.command, 'py')
    assert.deepEqual(news.args.slice(0, 3), [
      '-3',
      '-m',
      'balancita_engine.futures_news',
    ])
  })

  it('does not start without Python and can be switched off with NEWS_ENABLED=0', () => {
    assert.ok(
      !names(devChildSpecs({ ...base, env: {}, python: null })).includes(
        'news',
      ),
    )
    assert.ok(
      !names(devChildSpecs({ ...base, env: { NEWS_ENABLED: '0' } })).includes(
        'news',
      ),
    )
    assert.ok(
      names(devChildSpecs({ ...base, env: { NEWS_ENABLED: '1' } })).includes(
        'news',
      ),
    )
  })

  it('analyses with the local model only when the llm child is enabled, on the same port', () => {
    const on = byName(
      devChildSpecs({ ...base, env: { ...local, LLAMA_PORT: '9001' }, llm }),
    )
    assert.ok(on.news.args.includes('--analyze'))
    assert.equal(on.news.env.LLAMA_PORT, '9001')
    // no local model, no llama-server binary, or DECISIONS_ENABLED off: ingest only
    for (const options of [
      { env: {}, llm },
      { env: local, llm: null },
      { env: local, llm: undefined },
    ])
      assert.ok(
        !byName(devChildSpecs({ ...base, ...options })).news.args.includes(
          '--analyze',
        ),
      )
    // llm absent because resolveLlamaServer found DECISIONS_ENABLED=0
    assert.ok(
      !byName(
        devChildSpecs({ ...base, env: { ...local, DECISIONS_ENABLED: '0' } }),
      ).news.args.includes('--analyze'),
    )
  })

  it('keeps news independent of llm and q: it starts before them and a stopped model does not matter', () => {
    const specs = devChildSpecs({ ...base, env: local, llm })
    assert.deepEqual(names(specs).slice(-3), ['news', 'llm', 'q'])
  })

  it('never hands the news child a remote LLM setting', () => {
    const { news } = byName(devChildSpecs({ ...base, env: local, llm }))
    assert.ok(!news.args.some((a) => /http|gemini|api/i.test(a)))
  })
})

describe('resolveLlamaServer', () => {
  const found = () => ({ status: 0, stdout: 'version: 1', stderr: '' })
  const missing = () => ({ error: new Error('spawn llama-server ENOENT') })

  it('is enabled when the binary runs and DECISIONS_ENABLED is not 0', () => {
    for (const env of [{}, { DECISIONS_ENABLED: '1' }])
      assert.equal(
        resolveLlamaServer({ env, run: found }).command,
        'llama-server',
      )
  })

  it('is disabled by DECISIONS_ENABLED=0 without even probing the binary', () => {
    const calls = []
    const result = resolveLlamaServer({
      env: { DECISIONS_ENABLED: '0' },
      run: (...a) => (calls.push(a), found()),
    })
    assert.equal(result.command, undefined)
    assert.deepEqual(calls, [])
    assert.match(result.message, /DECISIONS_ENABLED=0/)
  })

  it('reports one message when the binary is not on PATH', () => {
    const result = resolveLlamaServer({ env: {}, run: missing })
    assert.equal(result.command, undefined)
    assert.match(result.message, /llama-server/)
    assert.match(result.message, /PATH/)
    assert.ok(!result.message.includes('\n'))
  })

  it('probes the binary named llama-server', () => {
    const calls = []
    resolveLlamaServer({
      env: {},
      run: (command, args) => (calls.push([command, args]), found()),
    })
    assert.equal(calls[0][0], 'llama-server')
  })
})

describe('port check includes llm only when enabled', () => {
  it('probes the llama port on loopback when it is passed as extra', async () => {
    const calls = []
    await checkDevPorts({
      extra: [{ name: 'llm', port: 9001, host: '127.0.0.1' }],
      probe: async (port, host) => (calls.push([port, host]), true),
    })
    assert.deepEqual(calls.at(-1), [9001, '127.0.0.1'])
  })

  it('does not probe it by default', async () => {
    const ports = []
    await checkDevPorts({ probe: async (port) => (ports.push(port), true) })
    assert.ok(!ports.includes(8088))
  })

  it('names llm in the conflict and planStartup forwards extra', async () => {
    const plan = await planStartup({
      extra: [{ name: 'llm', port: 8088, host: '127.0.0.1' }],
      probe: async (port) => port !== 8088,
    })
    assert.equal(plan.start, false)
    assert.match(plan.messages[0], /8088 \(llm\)/)
  })
})

// Fake filesystem: `files` maps absolute paths to true (complete file) or false
// (dangling symlink / empty). Directories are derived from the paths.
function fakeFs(files) {
  const paths = Object.keys(files)
  return {
    readdir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const entries = new Map()
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue
        const [name, ...rest] = path.slice(prefix.length).split('/')
        entries.set(name, rest.length > 0)
      }
      return [...entries].map(([name, directory]) => ({ name, directory }))
    },
    isFile: (path) => files[path] === true,
  }
}

describe('loadDevEnv', () => {
  const files = {
    '/repo/.env': 'A=env\nB=env\nC=env\n# comment\n\nQUOTED="a b"\n',
    '/repo/.env.local': "B=local\nC=local\nSINGLE='x y'\n",
  }
  const read = (path) => files[path]

  it('lets process.env win over .env.local over .env', () => {
    const env = loadDevEnv({ root: '/repo', env: { C: 'real' }, read })
    assert.equal(env.A, 'env')
    assert.equal(env.B, 'local')
    assert.equal(env.C, 'real')
  })

  it('parses comments, blank lines and quotes', () => {
    const env = loadDevEnv({ root: '/repo', env: {}, read })
    assert.equal(env.QUOTED, 'a b')
    assert.equal(env.SINGLE, 'x y')
    assert.ok(!Object.keys(env).some((key) => key.startsWith('#')))
  })

  it('tolerates missing files and does not mutate its input', () => {
    const input = { X: '1' }
    const env = loadDevEnv({ root: '/repo', env: input, read: () => undefined })
    assert.deepEqual(env, { X: '1' })
    assert.deepEqual(input, { X: '1' })
  })
})

describe('findQwenModel', () => {
  const home = '/home/me'
  const mac = (files, env = {}) =>
    findQwenModel({ env, home, platform: 'darwin', fs: fakeFs(files) })
  const llamaCache = '/home/me/Library/Caches/llama.cpp'

  it('finds a llama.cpp cache download on macOS, case-insensitively', () => {
    const path = `${llamaCache}/unsloth_Qwen3.5-4B-GGUF_QWEN3.5-4B-Q8_0.GGUF`
    assert.equal(mac({ [path]: true }), path)
  })

  it('uses ~/.cache/llama.cpp on Linux and LLAMA_CACHE when set', () => {
    const linux = '/home/me/.cache/llama.cpp/Qwen3.5-4B-Q8_0.gguf'
    assert.equal(
      findQwenModel({
        env: {},
        home,
        platform: 'linux',
        fs: fakeFs({ [linux]: true }),
      }),
      linux,
    )
    const custom = '/data/cache/Qwen3.5-4B-Q8_0.gguf'
    assert.equal(
      mac({ [custom]: true }, { LLAMA_CACHE: '/data/cache' }),
      custom,
    )
  })

  it('finds the Hugging Face hub snapshot and honors HF_HOME', () => {
    const snap = 'hub/models--unsloth--Qwen3.5-4B-GGUF/snapshots/abc123'
    const path = `/home/me/.cache/huggingface/${snap}/Qwen3.5-4B-Q8_0.gguf`
    assert.equal(mac({ [path]: true }), path)
    const moved = `/hf/${snap}/Qwen3.5-4B-Q8_0.gguf`
    assert.equal(mac({ [moved]: true }, { HF_HOME: '/hf' }), moved)
  })

  it('finds LM Studio, ~/models and ~/Downloads', () => {
    for (const path of [
      '/home/me/.lmstudio/models/unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q8_0.gguf',
      '/home/me/.cache/lm-studio/models/unsloth/Qwen3.5-4B-GGUF/qwen3.5-4b-q8_0.gguf',
      '/home/me/models/qwen3.5-4b-q8_0.gguf',
      '/home/me/Downloads/Qwen3.5-4B-Q8_0.gguf',
    ])
      assert.equal(mac({ [path]: true }), path)
  })

  it('stays shallow: deep or unrelated directories are not searched', () => {
    assert.equal(
      mac({ '/home/me/Downloads/a/b/Qwen3.5-4B-Q8_0.gguf': true }),
      undefined,
    )
    assert.equal(
      mac({ '/home/me/Documents/Qwen3.5-4B-Q8_0.gguf': true }),
      undefined,
    )
  })

  it('ignores other models and sizes (Qwen3.5-14B and Qwen3-14B are not 4B)', () => {
    assert.equal(
      mac({
        '/home/me/models/Qwen3.5-14B-Q8_0.gguf': true,
        '/home/me/models/Qwen3-14B-Q8_0.gguf': true,
        '/home/me/models/Qwen3-8B-Q8_0.gguf': true,
      }),
      undefined,
    )
  })

  it('finds Qwen3-4B in the Hugging Face hub snapshot layout', () => {
    const path =
      '/home/me/.cache/huggingface/hub/models--Qwen--Qwen3-4B-GGUF/snapshots/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q8_0.gguf'
    assert.equal(mac({ [path]: true }), path)
  })

  it('prefers Qwen3.5-4B over Qwen3-4B even with a worse quant', () => {
    const q35 = '/home/me/Downloads/Qwen3.5-4B-Q6_K.gguf'
    const q3 = '/home/me/models/Qwen3-4B-Q8_0.gguf'
    assert.equal(mac({ [q35]: true, [q3]: true }), q35)
    assert.equal(mac({ [q3]: true }), q3)
  })

  it('prefers Q8_0, then Q6_K, then any other match', () => {
    const dir = '/home/me/models'
    const q4 = `${dir}/Qwen3.5-4B-Q4_K_M.gguf`
    const q6 = `${dir}/Qwen3.5-4B-Q6_K.gguf`
    const q8 = `${dir}/Qwen3.5-4B-Q8_0.gguf`
    assert.equal(mac({ [q4]: true, [q6]: true, [q8]: true }), q8)
    assert.equal(mac({ [q4]: true, [q6]: true }), q6)
    assert.equal(mac({ [q4]: true }), q4)
  })

  it('prefers the better quant over an earlier location, then the earlier location', () => {
    const cache = `${llamaCache}/Qwen3.5-4B-Q6_K.gguf`
    const downloads = '/home/me/Downloads/Qwen3.5-4B-Q8_0.gguf'
    assert.equal(mac({ [cache]: true, [downloads]: true }), downloads)
    const models = '/home/me/models/Qwen3.5-4B-Q8_0.gguf'
    assert.equal(mac({ [downloads]: true, [models]: true }), models)
  })

  it('excludes mmproj files', () => {
    assert.equal(
      mac({
        '/home/me/models/mmproj-Qwen3.5-4B-Q8_0.gguf': true,
        '/home/me/models/Qwen3.5-4B-F16-mmproj.gguf': true,
      }),
      undefined,
    )
  })

  it('excludes incomplete and partial downloads', () => {
    assert.equal(
      mac({
        [`${llamaCache}/Qwen3.5-4B-Q8_0.gguf.downloadInProgress`]: true,
        '/home/me/Downloads/Qwen3.5-4B-Q8_0.gguf.part': true,
        '/home/me/Downloads/Qwen3.5-4B-Q8_0.gguf.crdownload': true,
        '/home/me/Downloads/Qwen3.5-4B-Q8_0.gguf.incomplete': true,
        '/home/me/models/Qwen3.5-4B-Q8_0.gguf': false,
      }),
      undefined,
    )
  })

  it('does not throw when the filesystem fails', () => {
    const fs = {
      readdir() {
        throw new Error('EACCES')
      },
      isFile: () => true,
    }
    assert.equal(
      findQwenModel({ env: {}, home, platform: 'darwin', fs }),
      undefined,
    )
  })
})

describe('resolveLlamaModel', () => {
  const never = () => assert.fail('must not search')

  it('uses LLAMA_MODEL_PATH without searching', () => {
    const model = resolveLlamaModel({
      env: { LLAMA_MODEL_PATH: '/m/x.gguf', LLAMA_HF: 'a/b' },
      findModel: never,
    })
    assert.deepEqual(model.args, ['-m', '/m/x.gguf'])
    assert.match(model.message, /^\[dev\] /)
    assert.match(model.message, /LLAMA_MODEL_PATH/)
    assert.match(model.message, /\/m\/x\.gguf/)
  })

  it('uses LLAMA_HF without searching', () => {
    const model = resolveLlamaModel({
      env: { LLAMA_HF: 'a/b:Q4' },
      findModel: never,
    })
    assert.deepEqual(model.args, ['-hf', 'a/b:Q4'])
    assert.match(model.message, /LLAMA_HF/)
  })

  it('uses a discovered file and names it', () => {
    const model = resolveLlamaModel({
      env: {},
      findModel: () => '/home/me/models/Qwen3.5-4B-Q8_0.gguf',
    })
    assert.deepEqual(model.args, ['-m', '/home/me/models/Qwen3.5-4B-Q8_0.gguf'])
    assert.match(
      model.message,
      /found \/home\/me\/models\/Qwen3\.5-4B-Q8_0\.gguf/,
    )
    assert.match(model.message, /LLAMA_MODEL_PATH/)
    assert.ok(!model.message.includes('\n'))
  })

  it('never falls back to a download when nothing is found', () => {
    const model = resolveLlamaModel({ env: {}, findModel: () => undefined })
    assert.equal(model.args, undefined)
    assert.match(model.message, /^\[dev\] /)
    assert.match(model.message, /no local/)
    assert.match(model.message, /LLAMA_MODEL_PATH/)
    assert.ok(!model.message.includes('\n'))
  })

  it('treats blank env values as unset', () => {
    const model = resolveLlamaModel({
      env: { LLAMA_MODEL_PATH: ' ', LLAMA_HF: '' },
      findModel: () => '/x/Qwen3.5-4B-Q8_0.gguf',
    })
    assert.deepEqual(model.args, ['-m', '/x/Qwen3.5-4B-Q8_0.gguf'])
  })
})

describe('devChildSpecs model selection', () => {
  const specs = (env, findModel) =>
    devChildSpecs({
      root,
      env,
      allowedFlags: noFlags,
      python: { command: 'python3', prefixArgs: [] },
      llm: { command: 'llama-server' },
      findModel,
    }).find((spec) => spec.name === 'llm')

  it('passes -m with the discovered file', () => {
    const { args } = specs({}, () => '/found/Qwen3.5-4B-Q8_0.gguf')
    assert.deepEqual(args.slice(0, 2), ['-m', '/found/Qwen3.5-4B-Q8_0.gguf'])
  })

  it('keeps LLAMA_MODEL_PATH first and has no llm child (no -hf) without a model', () => {
    assert.deepEqual(
      specs({ LLAMA_MODEL_PATH: '/p.gguf' }, () => '/found.gguf').args.slice(
        0,
        2,
      ),
      ['-m', '/p.gguf'],
    )
    assert.equal(specs({}), undefined)
  })
})
