import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLoopMonitor, type LoopSample } from './loop-monitor.ts'

describe('loop monitor', () => {
  it('shows a synchronous block as the worst timer delay of its window and writes it down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-loop-'))
    try {
      const file = join(dir, 'eventloop.jsonl')
      const samples: LoopSample[] = []
      const logs: string[] = []
      const monitor = createLoopMonitor({
        file,
        windowMs: 10_000,
        warnMs: 100,
        log: (line) => logs.push(line),
        onSample: (sample) => samples.push(sample),
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const until = Date.now() + 300
      while (Date.now() < until) {
        // block the loop like a synchronous delete would
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      const sample = monitor.flush()
      monitor.stop()
      expect(sample.maxMs).toBeGreaterThan(200)
      expect(samples).toHaveLength(1)
      expect(logs.some((line) => line.includes('event loop blocked'))).toBe(
        true,
      )
      const line = JSON.parse(readFileSync(file, 'utf8').trim()) as LoopSample
      expect(line.maxMs).toBe(sample.maxMs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
