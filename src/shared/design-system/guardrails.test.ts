import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const THEME = 'src/shared/design-system/theme.css'

function cssViolations(paths: string[]) {
  return paths
    .filter((path) => path !== THEME)
    .map(
      (path) =>
        `${path}: new CSS file; use theme tokens and component utilities`,
    )
}

function classViolations(sources: Record<string, string>) {
  const options: ts.CompilerOptions = {
    jsx: ts.JsxEmit.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    types: [],
    allowImportingTsExtensions: true,
  }
  const files = new Map(
    Object.entries(sources).map(([path, source]) => [`/${path}`, source]),
  )
  const host = ts.createCompilerHost(options)
  host.getCurrentDirectory = () => '/'
  host.fileExists = (path) => files.has(path)
  host.readFile = (path) => files.get(path)
  host.directoryExists = (path) =>
    [...files.keys()].some((file) =>
      file.startsWith(`${path.replace(/\/$/, '')}/`),
    )
  host.getSourceFile = (path, languageVersion) => {
    const source = files.get(path)
    return source === undefined
      ? undefined
      : ts.createSourceFile(path, source, languageVersion, true)
  }
  const program = ts.createProgram([...files.keys()], options, host)
  const checker = program.getTypeChecker()
  const violations = new Set<string>()

  function inspect(text: string, node: ts.Node) {
    const rules: Array<[RegExp, string]> = [
      [/-\[|(?:^|\s|:)\[/, 'arbitrary value or variant'],
      [
        /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/i,
        'raw hex color',
      ],
      [
        /(?:^|\s|:)!?text-ink-3(?:$|[\s/!])/,
        'ink-3 is decoration-only, not text',
      ],
    ]
    for (const [pattern, rule] of rules) {
      if (!pattern.test(text)) continue
      const file = node.getSourceFile()
      const { line } = file.getLineAndCharacterOfPosition(node.getStart())
      violations.add(`${file.fileName.slice(1)}:${line + 1}: ${rule}: ${text}`)
    }
  }

  function collect(node: ts.Node, seen: Set<ts.Node>) {
    if (seen.has(node)) return
    seen.add(node)
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      inspect(node.text, node)
      return
    }
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node)
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol)
      }
      for (const declaration of symbol?.declarations ?? []) {
        if (
          (ts.isVariableDeclaration(declaration) ||
            ts.isParameter(declaration)) &&
          declaration.initializer
        ) {
          collect(declaration.initializer, seen)
        }
      }
      return
    }
    if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue, seen)
      collect(node.whenFalse, seen)
      return
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      collect(node.expression, seen)
      return
    }
    if (ts.isPropertyAssignment(node)) {
      // Object keys can be class names in conditional class maps.
      collect(node.name, seen)
      collect(node.initializer, seen)
      return
    }
    if (ts.isFunctionLike(node)) return
    ts.forEachChild(node, (child) => collect(child, seen))
  }

  for (const file of program.getSourceFiles()) {
    if (!file.fileName.endsWith('.tsx')) continue
    function visit(node: ts.Node) {
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(file) === 'className' &&
        node.initializer
      ) {
        collect(node.initializer, new Set())
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return [...violations].sort()
}

describe('design-system guard rails', () => {
  it.each([
    ['arbitrary dimension', '<div className="w-[437px]" />', 'arbitrary value'],
    [
      'responsive arbitrary value',
      '<div className="md:text-[13px]" />',
      'arbitrary value',
    ],
    [
      'arbitrary property',
      '<div className="[color:red]" />',
      'arbitrary value',
    ],
    [
      'arbitrary variant',
      '<div className="[&>p]:text-long" />',
      'arbitrary value',
    ],
    ['hex color', '<div className="text-#abcdef" />', 'raw hex'],
    ['short hex', '<div className={"bg-#abc"} />', 'raw hex'],
    ['alpha hex', '<div className="border-#12345678" />', 'raw hex'],
    ['text contrast', '<div className="text-ink-3" />', 'decoration-only'],
    [
      'variant contrast',
      '<div className="hover:!text-ink-3/50" />',
      'decoration-only',
    ],
    [
      'conditional',
      '<div className={ok ? "text-ink" : "text-ink-3!"} />',
      'decoration-only',
    ],
    [
      'template',
      '<div className={`p-4 ${ok ? "w-[4px]" : "w-full"}`} />',
      'arbitrary value',
    ],
    [
      'class map',
      'const tones = { bad: "text-ink-3" }; <div className={tones[tone]} />',
      'decoration-only',
    ],
    [
      'variable alias',
      'const a = "p-[4px]"; const b = a; <div className={b} />',
      'arbitrary value',
    ],
    [
      'class helper',
      '<div className={clsx("p-4", { "text-ink-3": ok })} />',
      'decoration-only',
    ],
  ])('rejects %s', (_name, source, message) => {
    const result = classViolations({ 'src/fixture.tsx': source })
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('src/fixture.tsx:1:')
    expect(result[0]).toContain(message)
  })

  it('follows imported class maps, including nested variant maps', () => {
    expect(
      classViolations({
        'src/variants.ts':
          'export const tones = { error: { title: "text-ink-3" } }',
        'src/fixture.tsx':
          'import { tones as kinds } from "./variants"; <p className={kinds[kind].title} />',
      }),
    ).toEqual([
      'src/variants.ts:1: ink-3 is decoration-only, not text: text-ink-3',
    ])
  })

  it('terminates cyclic references without ignoring other classes', () => {
    expect(
      classViolations({
        'src/fixture.tsx':
          'const a = b; const b = a; <div className={`${a} text-ink-3`} />',
      }),
    ).toHaveLength(1)
  })

  it('checks a default className parameter', () => {
    expect(
      classViolations({
        'src/fixture.tsx':
          'function Example(className = "text-ink-3") { return <div className={className} /> }',
      }),
    ).toHaveLength(1)
  })

  it('accepts semantic utilities, legacy classes and non-class data', () => {
    expect(
      classViolations({
        'src/fixture.tsx': `
        // Documentation example: className="w-[437px]"
        const example = 'className="text-ink-3"'
        const color = "#abcdef"
        const tones = { ok: "text-long", empty: "text-ink-2" }
        <div className={\`demo-shell p-4 bg-long/10 before:bg-ink-3 \${tones[tone]}\`}
          style={{ color: "#abcdef" }} data-example="text-ink-3">
          text-ink-3 is a token name, not a class here.
        </div>
      `,
      }),
    ).toEqual([])
  })

  it('allows only the theme and rejects legacy or new CSS anywhere under src', () => {
    expect(cssViolations([THEME])).toEqual([])
    expect(cssViolations(['src/shared/styles/ui.css'])).toHaveLength(1)
    expect(cssViolations(['src/features/example/new.css'])).toEqual([
      'src/features/example/new.css: new CSS file; use theme tokens and component utilities',
    ])
    // A renamed legacy file must not inherit permission from its old name.
    expect(cssViolations(['src/app/DemoShell-new.css'])).toHaveLength(1)
    expect(cssViolations([THEME])).toEqual([])
  })

  it('keeps application class names within the semantic design system', () => {
    const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const files = Object.fromEntries(
      Object.entries(sources)
        .filter(([path]) => !/\.(?:test|spec)\.[tj]sx?$/.test(path))
        .map(([path, source]) => {
          if (typeof source !== 'string')
            throw new Error(`Missing source: ${path}`)
          return [path.slice(1), source]
        }),
    )
    expect(classViolations(files)).toEqual([])
  })

  it('keeps the theme as the only application stylesheet', () => {
    const files = Object.keys(import.meta.glob('/src/**/*.css')).map((path) =>
      path.slice(1),
    )
    expect(cssViolations(files)).toEqual([])
    expect(files).toEqual([THEME])
  })

  it('does not reintroduce retired token aliases', () => {
    const sources = import.meta.glob('/src/**/*.{ts,tsx,css}', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const retired =
      /--mc-[\w-]+|--color-(?:background|surface|surface-muted|surface-elevated|text|muted|border|border-strong|accent|accent-soft|accent-contrast|focus|success|success-contrast|danger|danger-contrast|warning|warning-contrast|chart-grid)(?![\w-])|--(?:bg|text|text-muted|positive|negative|muted-color|border-color|accent-soft|success-color|card|muted-foreground|border|chart-up|chart-down|chart-volume-up|chart-volume-down|warning|info)(?![\w-])/
    for (const [path, source] of Object.entries(sources)) {
      if (/\.(?:test|spec)\.[tj]sx?$/.test(path)) continue
      expect(source, path).not.toMatch(retired)
    }
  })
})
