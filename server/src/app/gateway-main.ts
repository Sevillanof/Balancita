import { buildLiveGateway } from '../features/live-gateway/gateway.ts'
import { serverConfigFrom } from '../platform/config.ts'

async function main(): Promise<void> {
  const config = serverConfigFrom(process.env)
  // Read-only: opens the capture process's market DB, starts no collector/engine.
  const app = await buildLiveGateway({
    marketDbPath: config.futuresMarketDbPath,
    staleAfterMs: config.marketStaleAfterMs,
    allowedOrigins: [
      config.corsOrigin,
      'http://localhost',
      'http://127.0.0.1',
      'http://[::1]',
    ],
  })
  const shutdown = (signal: string) => {
    console.log(`[live-gateway] received ${signal}, shutting down...`)
    void app.close().then(() => process.exit(0))
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  await app.listen({ host: config.host, port: config.port })
  console.log(
    `[live-gateway] listening on http://${config.host}:${config.port} (read-only ${config.futuresMarketDbPath})`,
  )
}

main().catch((error) => {
  console.error('[live-gateway] failed to start', error)
  process.exitCode = 1
})
