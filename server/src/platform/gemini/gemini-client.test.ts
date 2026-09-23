import { describe, expect, it, vi } from 'vitest'
import { AnalysisUpstreamError } from '../analysis-errors.ts'
import type { GoogleGenAILike } from './gemini-client.ts'
import { GoogleGenaiClient } from './gemini-client.ts'

function fakeAi() {
  const generateContent =
    vi.fn<
      (params: {
        model: string
        contents: string
        config: Record<string, unknown>
      }) => Promise<{ text?: string }>
    >()
  return {
    models: { generateContent },
    generateContent,
  } as GoogleGenAILike & { generateContent: typeof generateContent }
}

describe('GoogleGenaiClient', () => {
  it('forwards model, prompt and structured output config to the SDK', async () => {
    const ai = fakeAi()
    ai.generateContent.mockResolvedValue({ text: '{"ok":true}' })
    const client = new GoogleGenaiClient(ai)
    const signal = new AbortController().signal

    const text = await client.generateStructuredText({
      model: 'gemini-3.5-flash-lite',
      prompt: 'assess',
      maxOutputTokens: 1024,
      jsonSchema: { type: 'object' },
      signal,
    })

    expect(text).toBe('{"ok":true}')
    expect(ai.generateContent).toHaveBeenCalledTimes(1)
    const params = ai.generateContent.mock.calls[0]![0]
    expect(params.model).toBe('gemini-3.5-flash-lite')
    expect(params.contents).toBe('assess')
    expect(params.config.responseMimeType).toBe('application/json')
    expect(params.config.responseJsonSchema).toEqual({ type: 'object' })
    expect(params.config.maxOutputTokens).toBe(1024)
    expect(params.config.abortSignal).toBe(signal)
  })

  it('rejects as an upstream error when no text comes back', async () => {
    const ai = fakeAi()
    ai.generateContent.mockResolvedValue({})
    const client = new GoogleGenaiClient(ai)

    await expect(
      client.generateStructuredText({
        model: 'gemini-3.5-flash-lite',
        prompt: 'assess',
        maxOutputTokens: 1024,
        signal: undefined,
      }),
    ).rejects.toThrow(AnalysisUpstreamError)
  })
})
