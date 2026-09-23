import { GoogleGenAI } from '@google/genai'
import { AnalysisUpstreamError } from '../analysis-errors.ts'

export interface GeminiGenerateParams {
  model: string
  prompt: string
  maxOutputTokens: number
  signal?: AbortSignal | null
  jsonSchema?: unknown
}

export interface GeminiClient {
  generateStructuredText(params: GeminiGenerateParams): Promise<string>
}

/** Minimal structural subset of the GoogleGenAI surface the adapter needs. */
export interface GoogleGenAILikeModels {
  generateContent(params: unknown): Promise<{ text?: string }>
}

export interface GoogleGenAILike {
  models: GoogleGenAILikeModels
}

/**
 * Adapter over @google/genai that forces structured JSON output through the
 * response JSON schema and refuses empty text with a typed upstream error.
 * No tools, grounding, files, audio, images or agents are ever enabled.
 */
export class GoogleGenaiClient implements GeminiClient {
  private readonly ai: GoogleGenAILike

  constructor(ai: GoogleGenAILike) {
    this.ai = ai
  }

  async generateStructuredText(params: GeminiGenerateParams): Promise<string> {
    const response = await this.ai.models.generateContent({
      model: params.model,
      contents: params.prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: params.jsonSchema,
        maxOutputTokens: params.maxOutputTokens,
        abortSignal: params.signal ?? undefined,
      },
    })
    const text = response.text
    if (text === undefined || text === '') {
      throw new AnalysisUpstreamError(
        'Gemini returned no text content in the response.',
      )
    }
    return text
  }
}

export function createGeminiClient(apiKey: string): GeminiClient {
  return new GoogleGenaiClient(new GoogleGenAI({ apiKey }))
}
