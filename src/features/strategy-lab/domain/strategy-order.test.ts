import { describe, expect, it } from 'vitest'
import type { InventoryStrategy } from '../infrastructure/strategy-api.ts'
import { groupStrategies, type Standing } from './strategy-order.ts'

const row = (id: string, kind: InventoryStrategy['kind'] = 'rules') =>
  ({ id, kind }) as InventoryStrategy

describe('groupStrategies', () => {
  it('puts Qwen and Kronos first, then one group per stage sorted by net per trade', () => {
    const standings = new Map<string, Standing>([
      ['a', { stage: 1, meanBp: -5 }],
      ['b', { stage: 1, meanBp: 12 }],
      ['c', { stage: 1, meanBp: null }],
      ['d', { stage: 4, meanBp: 3 }],
    ])
    const groups = groupStrategies(
      [
        row('a'),
        row('kronos', 'model'),
        row('b'),
        row('e'),
        row('c'),
        row('c31', 'qwen_exit'),
        row('d'),
        row('qwen-live', 'qwen_live'),
      ],
      standings,
    )
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.id)])).toEqual([
      [null, ['qwen-live', 'c31', 'kronos']],
      ['Hipótesis', ['e']],
      ['Optimizar', ['b', 'a', 'c']],
      ['Paper', ['d']],
    ])
  })
})
