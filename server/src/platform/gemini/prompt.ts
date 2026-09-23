import type { AnalysisInputRequest } from '../../features/analysis/wire.ts'

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
    'Es un asistente educativo de análisis para una aplicación personal de demostración.',
    'Responde en español neutral y profesional. Evalúa la tendencia actual, la',
    'volatilidad ATR y el estado de cartera. La recomendación es informativa:',
    'nunca ejecuta órdenes ni llama a ningún proveedor de ejecución.',
    '',
    'Devuelve SOLO JSON válido con esta estructura exacta (sin Markdown ni prosa):',
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
    'disclaimer debe ser claro y equivalente a: "Recomendación educativa e informativa: no es asesoramiento financiero y no ejecuta órdenes.".',
    '',
    'Contexto del instrumento (JSON):',
    context,
  ].join('\n')
}
