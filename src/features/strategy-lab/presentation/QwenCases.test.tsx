import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type {
  QCases,
  QDecisionCase,
  QNoDecisionCase,
} from '../infrastructure/strategy-api.ts'
import { QwenCases } from './QwenCases.tsx'

// DATOS DE EJEMPLO: cifras sintéticas de pruebas, nunca de la app.
const NOW = 1_800_000_000_000

const decision = (patch: Partial<QDecisionCase> = {}): QDecisionCase => ({
  kind: 'decision',
  product_id: 'PF_XBTUSD',
  bucket_start: NOW - 10 * 60_000,
  question_id: 'trade_action',
  question_version: 3,
  chosen: 'buy',
  probabilities: { buy: 0.6, hold: 0.3, sell: 0.1 },
  confidence: 0.6,
  probability_source: 'raw',
  prompt_version: 2,
  latency_ms: 840,
  model_ref: 'Qwen3-4B',
  written_at: NOW - 5 * 60_000,
  ...patch,
})

const noDecision = (
  code: string,
  reason: string,
  kind: 'skip' | 'error' = 'skip',
): QNoDecisionCase => ({
  kind,
  product_id: 'PF_ETHUSD',
  bucket_start: NOW - 20 * 60_000,
  question_id: 'trade_action',
  question_version: 3,
  code,
  reason,
  written_at: NOW - 2 * 60_000,
})

const cases = (patch: Partial<QCases> = {}): QCases => ({
  available: true,
  reason: null,
  model: null,
  latest: [],
  ...patch,
})

describe('QwenCases: qué decide Qwen en cada caso (datos de ejemplo)', () => {
  it('shows the chosen option, probabilities, confidence, question@version, prompt, source and latency', () => {
    render(<QwenCases cases={cases({ latest: [decision()] })} now={NOW} />)
    const row = screen.getByTestId('q-case-decision')
    expect(row).toHaveTextContent('PF_XBTUSD')
    expect(row).toHaveTextContent('Decide: Comprar')
    expect(row).toHaveTextContent('trade_action@3')
    expect(row).toHaveTextContent('Confianza 60 %')
    expect(row).toHaveTextContent('prompt v2')
    expect(row).toHaveTextContent('fuente raw')
    expect(row).toHaveTextContent('840 ms')
    expect(row).toHaveTextContent('hace 5 min')
    const bars = within(screen.getByTestId('q-case-probabilities'))
    expect(bars.getByText('Comprar 60 %')).toBeInTheDocument()
    expect(bars.getByText('Mantener 30 %')).toBeInTheDocument()
    expect(bars.getByText('Vender 10 %')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Comprar' })).toHaveAttribute(
      'aria-valuenow',
      '60',
    )
  })

  it('shows the precise reason when there is no decision', () => {
    render(
      <QwenCases
        cases={cases({
          latest: [
            noDecision(
              'model_down',
              'modelo local caído (llama-server no responde)',
            ),
            noDecision('model_loading', 'llama-server está cargando el modelo'),
            noDecision('calm_skip', 'tramo en calma', 'skip'),
            noDecision('no_letters', 'sin letra de opción', 'error'),
          ],
        })}
        now={NOW}
      />,
    )
    const rows = screen.getAllByTestId('q-case-none')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('Sin decisión')
    expect(rows[0]).toHaveTextContent('Modelo local caído')
    expect(rows[0]).toHaveTextContent(
      'modelo local caído (llama-server no responde)',
    )
    expect(rows[1]).toHaveTextContent('Modelo local cargando')
    expect(rows[2]).toHaveTextContent('Filtro de calma')
    expect(rows[3]).toHaveTextContent('Sin letra de opción')
    expect(screen.queryByTestId('q-case-probabilities')).toBeNull()
  })

  it('keeps an unknown code readable', () => {
    render(
      <QwenCases
        cases={cases({ latest: [noDecision('algo_nuevo', 'motivo')] })}
        now={NOW}
      />,
    )
    expect(screen.getByTestId('q-case-none')).toHaveTextContent('algo_nuevo')
  })

  it('says the local model was never started, apart from "llama-server no responde"', () => {
    render(
      <QwenCases
        cases={cases({
          model: {
            code: 'not_started',
            reason:
              'modelo local no iniciado: falta LLAMA_MODEL_PATH y no se encontró ningún GGUF',
          },
          latest: [
            noDecision(
              'model_down',
              'modelo local caído (llama-server no responde)',
            ),
          ],
        })}
        now={NOW}
      />,
    )
    const banner = screen.getByTestId('q-model-state')
    expect(banner).toHaveTextContent('Modelo local no iniciado')
    expect(banner).toHaveTextContent('falta LLAMA_MODEL_PATH')
    expect(banner).toHaveTextContent('Los saltos de abajo son anteriores')
  })

  it('says a stopped llama-server is stopped, not never started', () => {
    render(
      <QwenCases
        cases={cases({
          model: {
            code: 'llm_stopped',
            reason:
              'llama-server se detuvo (salió con 1): el modelo local ya no corre',
          },
        })}
        now={NOW}
      />,
    )
    const banner = screen.getByTestId('q-model-state')
    expect(banner).toHaveTextContent('llama-server detenido')
    expect(banner).toHaveTextContent('salió con 1')
  })

  it('says why there is nothing to list', () => {
    const { rerender } = render(
      <QwenCases
        cases={cases({
          available: false,
          reason: 'sin base de decisiones de Q',
        })}
        now={NOW}
      />,
    )
    expect(screen.getByTestId('q-cases')).toHaveTextContent(
      'sin base de decisiones de Q',
    )
    rerender(<QwenCases cases={cases()} now={NOW} />)
    expect(screen.getByTestId('q-cases')).toHaveTextContent(
      'Q no ha decidido ni saltado ningún caso',
    )
    rerender(<QwenCases cases={undefined} now={NOW} />)
    expect(screen.getByTestId('q-cases')).toHaveTextContent(
      'no devuelve las decisiones de Q',
    )
    rerender(<QwenCases cases={null} now={NOW} />)
    expect(screen.getByTestId('q-cases')).toHaveTextContent(
      'no tiene configurada la lectura',
    )
  })

  it('has no controls: it only reads', () => {
    render(<QwenCases cases={cases({ latest: [decision()] })} now={NOW} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
