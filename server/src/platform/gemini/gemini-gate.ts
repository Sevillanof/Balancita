import type { GeminiClient, GeminiGenerateParams } from './gemini-client.ts'

export class GeminiGate implements GeminiClient {
  private enabled = false
  private readonly client: GeminiClient

  constructor(client: GeminiClient) {
    this.client = client
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }
  get isEnabled(): boolean {
    return this.enabled
  }
  status(apiKeyConfigured: boolean) {
    return { enabled: this.enabled, apiKeyConfigured }
  }
  generateStructuredText(params: GeminiGenerateParams): Promise<string> {
    if (!this.enabled) return Promise.reject(new Error('Gemini is disabled.'))
    return this.client.generateStructuredText(params)
  }
}
