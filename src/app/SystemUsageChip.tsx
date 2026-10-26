import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'
import { number, summarizeUsage } from './system-usage.ts'

const POLL_MS = 5_000

/** Resource usage of the app (CPU, saved data, Qwen and Kronos), polled from the live gateway. */
export default function SystemUsageChip({ apiBase }: { apiBase: string }) {
  const [result, setResult] = useState<{
    base: string
    body: unknown
    error: string | null
  }>()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let cancelled = false
    let sequence = 0
    let controller: AbortController | undefined
    const load = async () => {
      const request = ++sequence
      controller?.abort()
      controller = new AbortController()
      try {
        const response = await fetch(`${apiBase}/system`, {
          signal: controller.signal,
        })
        const received = Date.now()
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body: unknown = await response.json()
        const at = number(record(body).at_ms)
        if (at !== null && at > received)
          throw new Error('Desfase de reloj en la respuesta')
        if (!cancelled && request === sequence) {
          setNow(Date.now())
          setResult({ base: apiBase, body, error: null })
        }
      } catch (error) {
        if (!cancelled && request === sequence) {
          setResult({
            base: apiBase,
            body: null,
            error: error instanceof Error ? error.message : 'Error de conexión',
          })
        }
      }
    }
    void load()
    const timer = setInterval(() => {
      void load()
    }, POLL_MS)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      cancelled = true
      controller?.abort()
      clearInterval(timer)
      clearInterval(clock)
    }
  }, [apiBase])
  const current = result?.base === apiBase ? result : undefined
  const usage = summarizeUsage(current?.body, now)
  return (
    <span
      className="justify-self-start rounded-badge border border-solid border-line-strong bg-canvas px-2 py-1 font-brand-mono text-badge font-medium whitespace-nowrap text-ink-2 header-compact:px-1.5 header-compact:text-badge-compact"
      data-testid="system-usage"
      title={
        current?.error
          ? `Consulta no disponible: ${current.error}\n${usage.title}`
          : usage.title
      }
    >
      CPU {usage.cpu} · DATOS {usage.data} · QWEN {usage.qwen} · KRONOS{' '}
      {usage.kronos}
    </span>
  )
}
