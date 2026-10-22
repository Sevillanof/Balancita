import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SystemUsageChip from './SystemUsageChip.tsx'

const now = 100_000
const sample = {
  schema: 'system-usage.v1',
  status: 'ok',
  at_ms: now,
  cached_at_ms: now,
  sampled_at_ms: now,
  supervisor_updated_at_ms: now,
  cpu_pct: 0,
  rss_mb: 0,
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })
const chip = () => screen.getByTestId('system-usage')
const flush = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('polls every five seconds, ages while pending, and never treats high CPU as severity', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(sample))
    .mockImplementation(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetcher)
  render(<SystemUsageChip apiBase="/a" />)
  await flush()
  expect(chip()).toHaveTextContent('CPU 0 %')
  await act(async () => {
    vi.advanceTimersByTime(16_000)
  })
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(chip()).toHaveTextContent('CPU —')
  expect(chip().title).toMatch(/obsoleta/)
  cleanup()
  fetcher.mockResolvedValue(
    json({
      ...sample,
      at_ms: now + 16_000,
      sampled_at_ms: now + 16_000,
      cpu_pct: 250,
    }),
  )
  render(<SystemUsageChip apiBase="/a" />)
  await flush()
  expect(chip()).toHaveTextContent('CPU 250 %')
  expect(chip()).not.toHaveAttribute('data-tone', 'bad')
})

it('clears last good evidence on HTTP failure even if the failed body looks valid', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(json(sample))
      .mockResolvedValue(json(sample, 503)),
  )
  render(<SystemUsageChip apiBase="/a" />)
  await flush()
  expect(chip()).toHaveTextContent('CPU 0 %')
  await act(async () => {
    vi.advanceTimersByTime(5000)
  })
  expect(chip()).toHaveTextContent('CPU —')
  expect(chip().title).toMatch(/HTTP 503/)
})

it('rejects future response clocks at receipt even after local time catches up', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(json({ ...sample, at_ms: now + 1000 }))
      .mockImplementation(() => new Promise(() => {})),
  )
  render(<SystemUsageChip apiBase="/a" />)
  await flush()
  await act(async () => {
    vi.advanceTimersByTime(2000)
  })
  expect(chip()).toHaveTextContent('CPU —')
  expect(chip().title).toMatch(/reloj/)
})

it('checks the response clock at receipt, not after delayed JSON decoding', async () => {
  let resolveBody!: (value: unknown) => void
  const response = {
    ok: true,
    json: () =>
      new Promise((resolve) => {
        resolveBody = resolve
      }),
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  render(<SystemUsageChip apiBase="/a" />)
  await flush()
  await act(async () => {
    vi.advanceTimersByTime(2000)
  })
  await act(async () => {
    resolveBody({ ...sample, at_ms: now + 1000 })
  })
  expect(chip()).toHaveTextContent('CPU —')
  expect(chip().title).toMatch(/reloj/)
})

it('guards supersession, base changes and unmount even when fetch ignores abort', async () => {
  const requests: {
    resolve: (value: Response) => void
    signal: AbortSignal
  }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({ resolve, signal: init.signal as AbortSignal })
        }),
    ),
  )
  const { rerender, unmount } = render(<SystemUsageChip apiBase="/a" />)
  await act(async () => {
    vi.advanceTimersByTime(5000)
  })
  expect(requests[0].signal.aborted).toBe(true)
  await act(async () => {
    requests[1].resolve(json({ ...sample, cpu_pct: 20 }))
  })
  await act(async () => {
    requests[0].resolve(json({ ...sample, cpu_pct: 99 }))
  })
  expect(chip()).toHaveTextContent('CPU 20 %')
  await act(async () => {
    vi.advanceTimersByTime(5000)
  })
  rerender(<SystemUsageChip apiBase="/b" />)
  expect(chip()).toHaveTextContent('CPU —')
  expect(requests[2].signal.aborted).toBe(true)
  await act(async () => {
    requests[3].resolve(json({ ...sample, cpu_pct: 30 }))
  })
  await act(async () => {
    requests[2].resolve(json({ ...sample, cpu_pct: 88 }))
  })
  expect(chip()).toHaveTextContent('CPU 30 %')
  await act(async () => {
    vi.advanceTimersByTime(5000)
  })
  unmount()
  expect(requests[4].signal.aborted).toBe(true)
  await act(async () => {
    requests[4].resolve(json(sample))
    vi.advanceTimersByTime(10_000)
  })
  expect(requests).toHaveLength(5)
})

it.each(['network', 'json'])(
  'clears evidence after a %s failure',
  async (failure) => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(sample))
    if (failure === 'network')
      fetcher.mockRejectedValue(new Error('Sin conexión'))
    else fetcher.mockResolvedValue(new Response('invalid JSON'))
    vi.stubGlobal('fetch', fetcher)
    render(<SystemUsageChip apiBase="/a" />)
    await flush()
    expect(chip()).toHaveTextContent('CPU 0 %')
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(chip()).toHaveTextContent('CPU —')
    expect(chip().title).toMatch(/Consulta no disponible/)
  },
)
