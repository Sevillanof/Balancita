import { describe, expect, it } from 'vitest'
import { buildAnalysisPrompt } from './prompt.ts'

describe('buildAnalysisPrompt', () => {
  it('requests Spanish educational guidance without order execution', () => {
    const prompt = buildAnalysisPrompt({
      instrumentId: 'BTC-EUR',
      symbol: 'BTC-EUR',
      assetClass: 'crypto',
      currency: 'EUR',
      quote: {
        price: 60_000,
        change: 300,
        changePercent: 0.5,
        timestamp: '2026-09-20T12:00:00.000Z',
        status: 'mock',
      },
      candles: [],
      holding: null,
    })
    expect(prompt).toMatch(/watch/)
    expect(prompt).toMatch(/neutral/)
    expect(prompt).toMatch(/review/)
    expect(prompt).toMatch(/recommendation.*buy.*sell.*hold/s)
    expect(prompt.toLowerCase()).toMatch(/órdenes/)
    expect(prompt).toMatch(/español neutral/)
    expect(prompt).toMatch(/"buy"|"sell"/)
  })

  it('is deterministic for the same input', () => {
    const input = {
      instrumentId: 'TTWO',
      symbol: 'TTWO',
      assetClass: 'equity' as const,
      currency: 'USD' as const,
      quote: {
        price: 150,
        change: -2,
        changePercent: -1.3,
        timestamp: '2026-09-20T12:00:00.000Z',
        status: 'mock',
      },
      candles: [
        {
          time: '2024-01-01T00:00:00.000Z',
          open: 140,
          high: 152,
          low: 138,
          close: 151,
          volume: 500,
        },
      ],
      holding: { quantity: '2', averageCost: '120' },
    }
    expect(buildAnalysisPrompt(input)).toBe(buildAnalysisPrompt(input))
  })

  it('embeds the instrument context so the model can reason about it', () => {
    const prompt = buildAnalysisPrompt({
      instrumentId: 'SPCX',
      symbol: 'SPCX',
      assetClass: 'unknown',
      currency: 'USD',
      quote: {
        price: 10,
        change: 0.5,
        changePercent: 5,
        timestamp: '2026-09-20T12:00:00.000Z',
        status: 'stale',
      },
      candles: [
        {
          time: '2024-01-01T00:00:00.000Z',
          open: 9,
          high: 10,
          low: 8,
          close: 9.5,
          volume: 100,
        },
      ],
      holding: { quantity: '3', averageCost: '12.5' },
    })
    expect(prompt).toContain('SPCX')
    expect(prompt).toContain('5')
    expect(prompt).toContain('stale')
    expect(prompt).toContain('12.5')
  })
})
