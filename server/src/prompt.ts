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
    'Sos un asistente educativo de análisis para una aplicación personal de demostración.',
    'Respondé en español neutral y profesional. Evaluá la tendencia actual, la',
    'volatilidad ATR y el estado de cartera. La recomendación es informativa:',
    'nunca ejecuta órdenes ni llama a ningún proveedor de ejecución.',
    '',
    'Return ONLY valid JSON with exactly this shape (no markdown, no prose):',
    '{',
    '  "instrumentId": string,',
    '  "classification": "watch" | "neutral" | "review",',
    '  "recommendation": "buy" | "sell" | "hold",',
    '  "reasons": string[],',
    '  "warnings": string[],',
    '  "volatility": {',
    '    "lookbackCandles": number,',
    '    "averageTrueRangePercent": number,',
    '    "level": "low" | "moderate" | "high"',
    '  }',
    '  "disclaimer": string',
    '}',
    '',
    'reasons debe explicar en español cómo la tendencia, la volatilidad y la',
    'cartera llevaron a la recomendación. warnings debe señalar datos faltantes,',
    'cotización desactualizada, señales contradictorias o volatilidad alta.',
    'Si no existe una posición, recommendation nunca puede ser "sell".',
    `disclaimer debe ser claro y equivalente a: "${'Recomendación educativa e informativa: no es asesoramiento financiero y no ejecuta órdenes.'}".`,
    '',
    'Instrument context (JSON):',
    context,
  ].join('\n')
}
