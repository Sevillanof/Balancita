import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.BALANCITA_UI_PORT ?? 5173)
const apiOrigin = process.env.FUTURES_API_ORIGIN ?? 'http://127.0.0.1:8787'
const server = await createServer({
  configFile: false,
  root,
  envDir: resolve(root, '.futures-ui-no-env'),
  plugins: [react()],
  appType: 'spa',
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: { '/api': { target: apiOrigin, ws: true, changeOrigin: true } },
  },
})

await server.listen()
console.log(`[futures-ui] serving http://127.0.0.1:${port}/terminal`)

let closing = false
const close = async () => {
  if (closing) return
  closing = true
  await server.close()
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void close())
