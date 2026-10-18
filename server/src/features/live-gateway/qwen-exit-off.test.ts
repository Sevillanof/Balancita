import { describe, expect, it } from 'vitest'
import { qwenExitOffFromEnv } from './qwen-exit-off.ts'

describe('qwenExitOffFromEnv', () => {
  it('is on when the variable is absent', () => {
    expect(qwenExitOffFromEnv({})).toBeUndefined()
  })
  it('is off with the reason and date from the launcher', () => {
    expect(
      qwenExitOffFromEnv({
        QWEN_EXIT_OFF_REASON: 'por decisión',
        QWEN_EXIT_OFF_SINCE: '2026-10-18',
      }),
    ).toEqual({ reason: 'por decisión', since: '2026-10-18' })
  })
  it('an empty reason is a loud config error, still off (never silently on)', () => {
    for (const reason of ['', '   ']) {
      const off = qwenExitOffFromEnv({ QWEN_EXIT_OFF_REASON: reason })
      expect(off).toBeDefined()
      expect(off?.reason).toContain('configuración inválida')
    }
  })
  it('a missing date is shown as not indicated', () => {
    expect(qwenExitOffFromEnv({ QWEN_EXIT_OFF_REASON: 'x' })?.since).toBe(
      'fecha no indicada',
    )
  })
})
