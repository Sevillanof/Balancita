import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
// @ts-expect-error -- untyped Node dev helper shared with scripts/dev.mjs
import { devProxyConfig } from './scripts/dev-provider-env.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    proxy: devProxyConfig(),
  },
})
