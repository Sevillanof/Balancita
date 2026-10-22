import { describe, expect, it } from 'vitest'
import { summarizeUsage } from './system-usage.ts'

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
  qwen: { running: true, decisions: null, exit_decisions: 9 },
  kronos: { running: true, trades: 4, decisions: null },
}

describe('resource evidence', () => {
  it('preserves measured zero, explains scope, and never fabricates throughput', () => {
    const result = summarizeUsage(sample, now)
    expect(result).toMatchObject({
      cpu: '0 %',
      data: '—',
      qwen: 'activo',
      kronos: 'activo',
    })
    expect(result.title).toMatch(/un núcleo/)
    expect(result.title).toMatch(/MiB.*no.*única.*GPU/)
    expect(result.title).toMatch(/PID.*únicos/)
    expect(result.title).toMatch(/solaparse.*propiedad/)
    expect(result.title).toMatch(/sin fuente acotada/)
    expect(result.title).not.toMatch(
      /9|4 operaciones|sin operaciones aún|0 decisiones/,
    )
    expect(summarizeUsage({ ...sample, cpu_pct: 250 }, now).cpu).toBe('250 %')
  })

  it.each([
    null,
    { cpu_pct: 0, rss_mb: 0 },
    { ...sample, status: 'unavailable' },
    { ...sample, sampled_at_ms: now - 15_001 },
    { ...sample, sampled_at_ms: now + 1 },
    { ...sample, supervisor_updated_at_ms: now - 30_001 },
    { ...sample, supervisor_updated_at_ms: now + 1 },
    { ...sample, rss_mb: null },
    { ...sample, at_ms: now + 1 },
    { ...sample, cpu_pct: -1 },
    { ...sample, sampled_at_ms: null },
    { ...sample, sampled_at_ms: -1 },
    { ...sample, cached_at_ms: now + 1 },
    { ...sample, supervisor_updated_at_ms: null },
  ])(
    'rejects missing, legacy, failed, stale or invalid resource evidence: %j',
    (body) => {
      expect(summarizeUsage(body, now).cpu).toBe('—')
    },
  )

  it('ages without another response and gates running on its own source', () => {
    expect(summarizeUsage(sample, now + 15_000).cpu).toBe('0 %')
    expect(summarizeUsage(sample, now + 15_001)).toMatchObject({
      cpu: '—',
      kronos: '—',
      qwen: 'activo',
    })
    expect(summarizeUsage(sample, now + 30_000).qwen).toBe('activo')
    expect(summarizeUsage(sample, now + 30_001).qwen).toBe('—')
    expect(summarizeUsage(null, now).title).toMatch(/sin fuente/)
    expect(
      summarizeUsage({ ...sample, status: 'unavailable' }, now).title,
    ).toMatch(/no disponible/)
    expect(
      summarizeUsage(
        { ...sample, qwen: { running: false }, kronos: { running: false } },
        now,
      ),
    ).toMatchObject({ qwen: 'apagado', kronos: 'apagado' })
  })

  it('uses separate storage time, lower bounds, categories and exclusions', () => {
    const storage = {
      status: 'partial',
      complete: false,
      sampled_at_ms: now,
      total_bytes: 1_048_576,
      scope: 'configured_data_directory',
      max_entries: 1000,
      max_depth: 3,
      excludes: ['models', 'other_roots', 'symlinks'],
      reason: 'entry_limit',
      bytes: { sqlite_main: 500, wal: 100, shm: 20, log: 30, other: 40 },
    }
    const body = { ...sample, sampled_at_ms: now - 20_000, storage }
    const result = summarizeUsage(body, now)
    expect(result).toMatchObject({ cpu: '—', data: '≥1,0 MiB' })
    expect(result.title).toMatch(/directorio configurado/)
    for (const text of [
      'SQLite',
      'WAL',
      'SHM',
      'logs',
      'otros',
      '1000',
      '3',
      'modelos',
      'otras raíces',
      'enlaces simbólicos',
      'entry_limit',
    ]) {
      expect(result.title).toContain(text)
    }
    expect(result.title).toMatch(/no.*lógicos.*liberables/)
    expect(summarizeUsage(body, now + 15_001).data).toBe('—')
    const cached = { ...body, at_ms: now + 15_001 }
    expect(summarizeUsage(cached, now + 15_001).data).toBe('—')
    expect(storage.sampled_at_ms).toBe(now)
    expect(
      summarizeUsage(
        { ...sample, storage: { ...storage, sampled_at_ms: now + 1 } },
        now,
      ).data,
    ).toBe('—')
    expect(
      summarizeUsage(
        { ...sample, storage: { ...storage, status: 'unavailable' } },
        now,
      ).data,
    ).toBe('—')
    expect(
      summarizeUsage(
        {
          ...sample,
          storage: { ...storage, status: 'ok', complete: true, total_bytes: 0 },
        },
        now,
      ).data,
    ).toBe('0,0 MiB')
  })
})
