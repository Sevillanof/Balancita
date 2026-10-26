import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = fileURLToPath(new URL('.', import.meta.url))

export function extractTokens(css) {
  const tokens = []
  const names = new Set()
  for (const block of css.matchAll(
    /@theme(?:\s+(?:static|inline))?\s*\{([^{}]*)\}/g,
  )) {
    const declarations = block[1].replace(/\/\*[\s\S]*?\*\//g, '')
    for (const declaration of declarations
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const match = /^--([\w*-]+)\s*:\s*([\s\S]+)$/.exec(declaration)
      if (!match)
        throw new Error(`Unsupported theme declaration: ${declaration}`)
      const [, name, raw] = match
      if (name.includes('*')) continue
      if (names.has(name)) throw new Error(`Duplicate theme token: ${name}`)
      const value = raw.replace(/\s+/g, ' ').trim()
      if (/\b(?:var|calc)\(/.test(value))
        throw new Error(`Unresolved theme token: ${name}`)
      names.add(name)
      const type = name.startsWith('color-')
        ? 'color'
        : name.startsWith('font-')
          ? 'font'
          : name.startsWith('text-')
            ? 'typography'
            : name.startsWith('radius-')
              ? 'radius'
              : name.startsWith('shadow-')
                ? 'shadow'
                : 'dimension'
      tokens.push({ name, value, type })
    }
  }
  if (tokens.length === 0) throw new Error('No theme tokens found')
  return tokens
}

export async function exportDesignSystem(
  output = resolve(root, 'dist/design-system'),
) {
  const css = await readFile(
    resolve(root, 'src/shared/design-system/theme.css'),
    'utf8',
  )
  const tokens = extractTokens(css)
  const usage = JSON.parse(
    await readFile(resolve(directory, 'tokens.usage.json'), 'utf8'),
  )
  for (const name of Object.keys(usage)) {
    if (!tokens.some((token) => token.name === name))
      throw new Error(`Unknown usage token: ${name}`)
  }
  await mkdir(output, { recursive: true })
  await writeFile(
    resolve(output, 'tokens.json'),
    JSON.stringify(tokens, null, 2) + '\n',
  )
  await writeFile(
    resolve(output, 'tokens.usage.json'),
    JSON.stringify(usage, null, 2) + '\n',
  )
  const template = await readFile(resolve(directory, 'catalog.html'), 'utf8')
  const data = JSON.stringify({ tokens, usage }).replace(/</g, '\\u003c')
  await writeFile(
    resolve(output, 'index.html'),
    template.replace('/* TOKEN_DATA */ null', data),
  )
  await copyFile(
    resolve(directory, 'catalog.mjs'),
    resolve(output, 'catalog.js'),
  )
  for (const font of ['inter', 'ibm-plex-mono']) {
    await copyFile(
      resolve(root, `node_modules/@fontsource/${font}/LICENSE`),
      resolve(output, `${font}-LICENSE.txt`),
    )
  }
  console.log(
    `Exported ${tokens.length} tokens and the local catalog to ${output}`,
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await exportDesignSystem()
}
