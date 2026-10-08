import { describe, expect, it } from 'vitest'
import { parseSpecText } from './strategy-spec.ts'

describe('parseSpecText', () => {
  it('tolerates markdown escapes and HTML entities', () => {
    const text =
      '{"schema": "balancita-strategy.v1", "params": {"volume\\_multiplier": "1.3"}, "op": "&gt;"}'
    const { spec, error } = parseSpecText(text)
    expect(error).toBeNull()
    expect(spec?.params).toEqual({ volume_multiplier: '1.3' })
  })

  it('reports where the JSON breaks', () => {
    const { spec, error } = parseSpecText('{"schema": }')
    expect(spec).toBeNull()
    expect(error).toMatch(/^No es un JSON válido\. .+/)
  })
})
