import type { AnalysisInputRequest } from './wire.ts'

/**
 * Deterministic, text-only prompt that turns a wire analysis input into a
 * structured surveillance verdict. It never enables tools, grounding, files,
 * audio or images: the model only receives text and must answer with plain
 * JSON following the schema below.
 */
export function buildAnalysisPrompt(input: AnalysisInputRequest): string {
  const context = JSON.stringify(
    {
      instrumentId: input.instrumentId,
      symbol: input.symbol,
      assetClass: input.assetClass,
      currency: input.currency,
      quote: input.quote,
      candles: input.candles,
      holding: input.holding,
    },
    null,
    2,
  )
  return [
    'You are a surveillance assistant for a personal demo trading app.',
    'Assess how much attention an instrument warrants. You are NEVER allowed',
    'to recommend buying, selling or any trading action: your only output is',
    'a classification of watch, neutral or review.',
    '',
    'Return ONLY valid JSON with exactly this shape (no markdown, no prose):',
    '{',
    '  "instrumentId": string,',
    '  "classification": "watch" | "neutral" | "review",',
    '  "reasons": string[],',
    '  "warnings": string[],',
    '  "volatility": {',
    '    "lookbackCandles": number,',
    '    "averageTrueRangePercent": number,',
    '    "level": "low" | "moderate" | "high"',
    '  }',
    '}',
    '',
    'reasons must list every signal that contributed to the verdict.',
    'warnings must flag data quality issues such as a stale quote, an unknown',
    'asset class or an empty candle history.',
    '',
    'Instrument context (JSON):',
    context,
  ].join('\n')
}
