import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig(({ mode }) => {
  if (mode === 'catalog-runtime') {
    return {
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        license: { fileName: 'runtime-licenses.json' },
        minify: true,
        outDir: 'dist/design-system',
        emptyOutDir: false,
        lib: {
          entry: fromRoot('./scripts/design-system/runtime.mjs'),
          name: 'BalancitaRuntime',
          formats: ['iife'],
          fileName: () => 'runtime.js',
        },
      },
    }
  }

  return {
    plugins: [
      {
        name: 'design-system-entry',
        enforce: 'pre',
        transform(code, id) {
          if (id === fromRoot('./src/shared/mission-control/index.ts')) {
            return `import '../design-system/theme.css';\n${code}`
          }
          if (id === fromRoot('./src/shared/design-system/theme.css')) {
            return code.replace(
              "@import 'tailwindcss/utilities.css' layer(utilities);",
              "@import 'tailwindcss/utilities.css' layer(utilities) source(none);\n@source '../mission-control/*.tsx';\n@source not '../mission-control/*.test.tsx';",
            )
          }
        },
        generateBundle(_options, bundle) {
          const js = bundle['bundle.js']
          if (!js || js.type !== 'chunk')
            throw new Error('Missing design-system bundle')
          js.code =
            '/*! @ds-bundle Balancita | generated from shared components */\n' +
            js.code
        },
      },
      tailwindcss(),
    ],
    oxc: {
      jsx: { runtime: 'classic' },
      jsxInject: "import * as React from 'react'",
    },
    build: {
      outDir: 'dist/design-system',
      emptyOutDir: true,
      lib: {
        entry: fromRoot('./src/shared/mission-control/index.ts'),
        name: 'Balancita',
        formats: ['iife'],
        fileName: () => 'bundle.js',
        cssFileName: 'bundle',
      },
      rolldownOptions: {
        external: ['react', 'react-dom', 'react-dom/client'],
        output: {
          globals: {
            react: 'React',
            'react-dom': 'ReactDOM',
            'react-dom/client': 'ReactDOM',
          },
        },
      },
    },
  }
})
