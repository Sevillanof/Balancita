import { describe, expect, it } from 'vitest'
import { groupDecisions, type DecisionRow } from './terminal-decisions.ts'

const row = (id: string, action: string): DecisionRow => ({
  id,
  action,
  strategy: 'C27',
  reason: '',
  time: '10:00',
})

describe('groupDecisions', () => {
  it('collapses consecutive WAIT runs and keeps single WAITs and signals as rows', () => {
    const items = groupDecisions([
      row('5', 'WAIT'),
      row('4', 'WAIT'),
      row('3', 'LONG'),
      row('2', 'WAIT'),
      row('1', 'SHORT'),
    ])
    expect(items.map((item) => item.kind)).toEqual([
      'waits',
      'row',
      'row',
      'row',
    ])
    expect(items[0]).toMatchObject({ rows: [{ id: '5' }, { id: '4' }] })
  })
})
