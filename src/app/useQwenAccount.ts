import { useEffect, useState } from 'react'
import { qwenAccount, type QwenAccount } from './account-balance.ts'

const POLL_MS = 15_000

/** The simulated account of Qwen operador (read-only, polled); null until the gateway answers or when it is off. */
export function useQwenAccount(): QwenAccount | null {
  const [account, setAccount] = useState<QwenAccount | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const response = await fetch('/api-live/qwen/account', {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setAccount(qwenAccount(await response.json()))
      } catch {
        if (!controller.signal.aborted) setAccount(null)
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])
  return account
}
