import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    proxy: {
      '/api/replay': {
        target: 'http://127.0.0.1:8787',
      },
      '/api/market': {
        target: 'http://127.0.0.1:8787',
      },
    },
  },
})
