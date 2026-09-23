import { describe, expect, it, vi } from 'vitest'
import { GeminiGate } from './gemini-gate.ts'
import type { GeminiClient } from './gemini-client.ts'

describe('GeminiGate', () => {
  it('starts disabled and blocks invocations until explicitly enabled', async () => {
    const generateStructuredText =
      vi.fn<GeminiClient['generateStructuredText']>()
    const gate = new GeminiGate({ generateStructuredText })

    await expect(
      gate.generateStructuredText({
        model: 'test',
        prompt: '',
        maxOutputTokens: 1,
      }),
    ).rejects.toThrow('Gemini is disabled.')
    expect(generateStructuredText).not.toHaveBeenCalled()

    gate.setEnabled(true)
    generateStructuredText.mockResolvedValue('ok')
    await expect(
      gate.generateStructuredText({
        model: 'test',
        prompt: '',
        maxOutputTokens: 1,
      }),
    ).resolves.toBe('ok')
    expect(gate.isEnabled).toBe(true)
  })

  it('blocks calls made after being disabled without exposing credentials', async () => {
    const client: GeminiClient = {
      generateStructuredText: vi.fn().mockResolvedValue('ok'),
    }
    const gate = new GeminiGate(client)
    gate.setEnabled(true)
    gate.setEnabled(false)

    await expect(
      gate.generateStructuredText({
        model: 'test',
        prompt: '',
        maxOutputTokens: 1,
      }),
    ).rejects.toThrow('Gemini is disabled.')
    expect(gate.status(true)).toEqual({
      enabled: false,
      apiKeyConfigured: true,
    })
    expect(JSON.stringify(gate.status(true))).not.toContain('secret')
  })
})
