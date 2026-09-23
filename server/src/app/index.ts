import { buildApp } from './app.ts'
import { serverConfigFrom } from '../platform/config.ts'

async function main(): Promise<void> {
  const config = serverConfigFrom(process.env)

  const app = await buildApp({ config })

  const shutdown = (signal: string) => {
    console.log(`[gemini-server] received ${signal}, shutting down...`)
    void app.close().then(() => process.exit(0))
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  if (config.apiKey === '') {
    console.warn(
      '[gemini-server] GEMINI_API_KEY is not set; POST /api/analyze will answer 503 missing_key.',
    )
  }

  await app.listen({ host: config.host, port: config.port })
  console.log(
    `[gemini-server] listening on http://${config.host}:${config.port} using ${config.model}`,
  )
}

main().catch((error) => {
  console.error('[gemini-server] failed to start', error)
  process.exitCode = 1
})
