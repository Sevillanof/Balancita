import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error -- untyped Node dev helper shared with scripts/dev.mjs
import { devProxyConfig } from './scripts/dev-provider-env.mjs'

// https://vite.dev/config/
const keepPageAlive = process.env.BALANCITA_HMR !== '1'

/**
 * The Terminal is a long-lived live screen (also served from the VPS over
 * Tailscale, where the HMR socket drops now and then). Vite's dev client
 * calls `location.reload()` whenever that socket drops or the server asks for
 * a full reload, which wipes the Terminal's state. Unless a developer opts in
 * with BALANCITA_HMR=1, the client never reloads the page by itself.
 */
function noAutoReload(): Plugin {
  return {
    name: 'balancita-no-auto-reload',
    apply: 'serve',
    enforce: 'post',
    transform(code, id) {
      if (!keepPageAlive) return null
      if (
        id !== '/@vite/client' &&
        !/vite[\\/]dist[\\/]client[\\/]client\.mjs/.test(id)
      )
        return null
      return { code: code.replaceAll('location.reload()', 'void 0'), map: null }
    },
  }
}

export default defineConfig({
  plugins: [
    noAutoReload(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  server: {
    proxy: devProxyConfig(),
  },
})
