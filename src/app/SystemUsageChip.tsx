import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'
import { number, summarizeUsage } from './system-usage.ts'

const POLL_MS = 5_000

/** Resource usage of the app (CPU, saved data, Qwen and Kronos), polled from the live gateway. */
export default function SystemUsageChip({ apiBase }: { apiBase: string }) {
  const [body, setBody] = useState<unknown>(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch(`${apiBase}/system`)
        .then((response) => response.json() as Promise<unknown>)
        .then((json) => {
          if (!cancelled) setBody(json)
        })
        .catch(() => {
          if (!cancelled) setBody(null)
        })
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [apiBase])
  const usage = summarizeUsage(body)
  const cpu = number(record(body).cpu_pct)
  return (
    <span
      className="demo-shell__badge demo-shell__badge--usage"
      data-testid="system-usage"
      data-tone={cpu !== null && cpu >= 150 ? 'bad' : undefined}
      title={usage.title}
    >
      CPU {usage.cpu} · DATOS {usage.data} · QWEN {usage.qwen} · KRONOS{' '}
      {usage.kronos}
    </span>
  )
}
