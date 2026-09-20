import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  AnalysisInvalidRequestError,
  AnalysisInvalidResponseError,
  AnalysisMissingKeyError,
  AnalysisQuotaExceededError,
  AnalysisTimeoutError,
  AnalysisUpstreamError,
  type AnalysisGatewayErrorCode,
} from './analysis-errors.ts'
import { AnalysisCache } from './cache.ts'
import type { ServerConfig } from './config.ts'
import { createGeminiClient, type GeminiClient } from './gemini-client.ts'
import { AnalysisRateLimiter } from './limits.ts'
import { AnalyzeService } from './service.ts'
import { parseAnalysisInputRequest } from './wire.ts'

export interface AnalysisDependencies {
  client: GeminiClient
  limiter: AnalysisRateLimiter
  cache: AnalysisCache
}

type ErrorEnvelope = {
  error: { code: AnalysisGatewayErrorCode | 'internal_error'; message: string }
}

function envelope(error: {
  code: AnalysisGatewayErrorCode | 'internal_error'
  message: string
}): ErrorEnvelope {
  return { error: { code: error.code, message: error.message } }
}

export async function buildApp(options: {
  config: ServerConfig
  overrides?: Partial<AnalysisDependencies>
}): Promise<FastifyInstance> {
  const { config } = options

  const limiter =
    options.overrides?.limiter ??
    new AnalysisRateLimiter({
      maxPerMinute: config.maxRequestsPerMinute,
      maxPerDay: config.maxRequestsPerDay,
    })
  const cache =
    options.overrides?.cache ??
    new AnalysisCache(config.cacheMaxEntries, config.cacheTtlMs)
  const client =
    options.overrides?.client ??
    (config.apiKey === '' ? undefined : createGeminiClient(config.apiKey))
  const service =
    client === undefined
      ? undefined
      : new AnalyzeService({
          client,
          limiter,
          cache,
          model: config.model,
          maxOutputTokens: config.maxOutputTokens,
          timeoutMs: config.timeoutMs,
        })

  const app = Fastify({ logger: false })

  if (config.corsOrigin !== '') {
    await app.register(cors, { origin: config.corsOrigin })
  }

  app.get('/health', async () => ({ status: 'ok' }))

  app.post('/api/analyze', async (request, reply) => {
    let input
    try {
      input = parseAnalysisInputRequest(request.body, config.maxCandles)
    } catch (error) {
      if (error instanceof AnalysisInvalidRequestError) {
        return reply.code(400).send(envelope(error))
      }
      throw error
    }

    if (service === undefined) {
      return reply
        .code(503)
        .send(
          envelope(
            new AnalysisMissingKeyError(
              'No Gemini API key is configured on the server.',
            ),
          ),
        )
    }

    try {
      const outcome = await service.analyze(input)
      return reply
        .code(200)
        .send({ result: outcome.result, cached: outcome.cached })
    } catch (error) {
      if (error instanceof AnalysisQuotaExceededError) {
        return reply.code(429).send(envelope(error))
      }
      if (error instanceof AnalysisTimeoutError) {
        return reply.code(504).send(envelope(error))
      }
      if (
        error instanceof AnalysisInvalidResponseError ||
        error instanceof AnalysisUpstreamError
      ) {
        return reply.code(502).send(envelope(error))
      }
      return reply.code(500).send(
        envelope({
          code: 'internal_error',
          message: 'An unexpected server error occurred.',
        }),
      )
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
      error instanceof Fastify.errorCodes.FST_ERR_CTP_BODY_TOO_LARGE
    ) {
      return reply
        .code(400)
        .send(
          envelope(
            new AnalysisInvalidRequestError(
              'The request body must be valid JSON.',
            ),
          ),
        )
    }
    return reply.code(500).send(
      envelope({
        code: 'internal_error',
        message: 'An unexpected server error occurred.',
      }),
    )
  })

  return app
}
