import type { GeminiClient } from '../../gemini-client.ts'
import type {
  NewsEvidenceRecord,
  NewsEventTaxonomy,
  NewsRelevance,
  TimestampMs,
} from '../contracts.ts'

export type NewsTradeIntent = 'buy' | 'sell' | 'neutral'

export interface NewsPresentation {
  readonly summary: string
  readonly tradeIntent: NewsTradeIntent
  readonly important: boolean
}

export interface NewsPresentationServiceOptions {
  readonly client?: GeminiClient
  readonly model: string
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly clock?: () => TimestampMs
}

export const NEWS_PRESENTATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tradeIntent: { enum: ['buy', 'sell', 'neutral'] },
    important: { type: 'boolean' },
  },
  required: ['summary', 'tradeIntent', 'important'],
  additionalProperties: false,
} as const

const FALLBACK_SUMMARY = 'No hay un resumen disponible para esta noticia.'

/** Presentation metadata is never persisted as authoritative evidence. */
export class NewsPresentationService {
  private readonly client: GeminiClient | undefined
  private readonly model: string
  private readonly maxOutputTokens: number
  private readonly timeoutMs: number
  private readonly clock: () => TimestampMs
  private readonly cache = new Map<string, Promise<NewsPresentation>>()
  private readonly resolved = new Map<string, NewsPresentation>()

  constructor(options: NewsPresentationServiceOptions) {
    if (options.timeoutMs <= 0)
      throw new Error('News presentation timeout must be positive.')
    if (options.maxOutputTokens <= 0)
      throw new Error('News presentation output limit must be positive.')
    this.client = options.client
    this.model = options.model
    this.maxOutputTokens = options.maxOutputTokens
    this.timeoutMs = options.timeoutMs
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
  }

  present(evidence: NewsEvidenceRecord): Promise<NewsPresentation> {
    const key = cacheKeyFor(evidence)
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached

    const pending = this.generate(evidence).then((result) => {
      this.resolved.set(key, result)
      return result
    })
    this.cache.set(key, pending)
    return pending
  }

  async prepare(evidence: readonly NewsEvidenceRecord[]): Promise<void> {
    await Promise.all(evidence.map((item) => this.present(item)))
  }

  get(evidence: NewsEvidenceRecord): NewsPresentation {
    return (
      this.resolved.get(cacheKeyFor(evidence)) ??
      deterministicPresentation(evidence)
    )
  }

  private async generate(
    evidence: NewsEvidenceRecord,
  ): Promise<NewsPresentation> {
    const fallback = deterministicPresentation(evidence)
    if (this.client === undefined) return fallback

    try {
      const text = await this.client.generateStructuredText({
        model: this.model,
        prompt: buildPresentationPrompt(evidence, this.clock()),
        maxOutputTokens: this.maxOutputTokens,
        signal: AbortSignal.timeout(this.timeoutMs),
        jsonSchema: NEWS_PRESENTATION_JSON_SCHEMA,
      })
      const parsed: unknown = JSON.parse(text)
      return isNewsPresentation(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }
}

export function deterministicPresentation(
  evidence: NewsEvidenceRecord,
): NewsPresentation {
  const sourceText =
    evidence.content.kind === 'metadata_only'
      ? evidence.metadata.title
      : evidence.content.text
  const summary = limitSummary(cleanSummary(sourceText)) || FALLBACK_SUMMARY
  return {
    summary,
    tradeIntent: deterministicTradeIntent(
      evidence.relevance,
      evidence.taxonomy,
    ),
    important: evidence.relevance === 'relevant',
  }
}

function deterministicTradeIntent(
  relevance: NewsRelevance,
  taxonomy: NewsEventTaxonomy,
): NewsTradeIntent {
  if (relevance !== 'relevant') return 'neutral'
  if (taxonomy === 'security' || taxonomy === 'regulation') return 'sell'
  if (
    taxonomy === 'technology' ||
    taxonomy === 'market_structure' ||
    taxonomy === 'exchange'
  )
    return 'buy'
  return 'neutral'
}

function buildPresentationPrompt(
  evidence: NewsEvidenceRecord,
  now: TimestampMs,
): string {
  const permittedText =
    evidence.content.kind === 'metadata_only' ? '' : evidence.content.text
  return [
    'Resume esta noticia oficial para la interfaz de Balancita.',
    'Devuelve exclusivamente JSON válido con {"summary","tradeIntent","important"}.',
    'summary debe estar en español profesional, tener entre 1 y 5 oraciones,',
    'usar únicamente hechos del título y del contenido permitido, y no inventar datos.',
    'tradeIntent solo puede ser "buy", "sell" o "neutral".',
    'important debe ser booleano. Esto no es asesoramiento financiero ni una orden.',
    `Fuente: ${evidence.source}`,
    `Título: ${evidence.metadata.title}`,
    `Contenido permitido: ${permittedText || '(solo metadata del título)'}`,
    `Publicada: ${new Date(evidence.publishedAt).toISOString()}`,
    `Día UTC actual: ${new Date(now).toISOString().slice(0, 10)}`,
  ].join('\n')
}

function isNewsPresentation(input: unknown): input is NewsPresentation {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return false
  const value = input as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'important,summary,tradeIntent')
    return false
  return (
    typeof value.summary === 'string' &&
    cleanSummary(value.summary) !== '' &&
    sentenceCount(value.summary) <= 5 &&
    (value.tradeIntent === 'buy' ||
      value.tradeIntent === 'sell' ||
      value.tradeIntent === 'neutral') &&
    typeof value.important === 'boolean'
  )
}

function cacheKeyFor(evidence: NewsEvidenceRecord): string {
  return `${evidence.id}:${evidence.version}:${evidence.contentHash}`
}

function cleanSummary(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function limitSummary(value: string): string {
  if (value === '') return ''
  return value
    .split(/(?<=[.!?])\s+/u)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ')
}

function sentenceCount(value: string): number {
  const normalized = cleanSummary(value)
  if (normalized === '') return 0
  return normalized.split(/(?<=[.!?])\s+/u).filter(Boolean).length
}
