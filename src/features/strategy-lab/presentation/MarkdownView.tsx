import { Fragment, type ReactNode } from 'react'

/**
 * A tiny, safe Markdown renderer for the gate report. It builds React
 * elements only (text is escaped by React, nothing is injected as HTML), and
 * supports what the report uses: headings, paragraphs, bullet lists, block
 * quotes, tables, code blocks, rules, `code`, **bold** and _italic_.
 * Raw HTML is never interpreted: it is shown as text (a bare `<sub>` wrapper
 * is dropped). Links and images are not supported on purpose.
 */

const INLINE =
  /(`[^`]+`|\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w)|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))/g

function inline(text: string, keyPrefix: string): ReactNode[] {
  const clean = text.replace(/<\/?sub>/g, '')
  return clean.split(INLINE).map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`'))
      return <code key={key}>{part.slice(1, -1)}</code>
    if (
      part.length > 4 &&
      ((part.startsWith('**') && part.endsWith('**')) ||
        (part.startsWith('__') && part.endsWith('__')))
    )
      return <strong key={key}>{inline(part.slice(2, -2), key)}</strong>
    if (
      part.length > 2 &&
      ((part.startsWith('*') && part.endsWith('*')) ||
        (part.startsWith('_') && part.endsWith('_')))
    )
      return <em key={key}>{inline(part.slice(1, -1), key)}</em>
    return <Fragment key={key}>{part}</Fragment>
  })
}

const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line)
const isRule = (line: string) =>
  /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line) ||
  /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line)

function cells(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  const next = () => `b${key++}`
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```'))
        body.push(lines[i++])
      i++
      out.push(
        <pre key={next()}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6) // the page owns the h1
      const Tag = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      const k = next()
      out.push(<Tag key={k}>{inline(heading[2], k)}</Tag>)
      i++
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*]\s+/, ''))
      const k = next()
      out.push(
        <ul key={k}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, `${k}-${n}`)}</li>
          ))}
        </ul>,
      )
      continue
    }
    if (line.startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i].startsWith('>'))
        quote.push(lines[i++].replace(/^>\s?/, ''))
      const k = next()
      out.push(<blockquote key={k}>{inline(quote.join(' '), k)}</blockquote>)
      continue
    }
    if (isRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]))
      const k = next()
      out.push(
        <div className="md__scroll" key={k}>
          <table>
            <thead>
              <tr>
                {head.map((cell, n) => (
                  <th key={n}>{inline(cell, `${k}-h${n}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, n) => (
                    <td key={n}>{inline(cell, `${k}-${r}-${n}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|>|\s*[-*]\s)/.test(lines[i]) &&
      !isRow(lines[i])
    )
      paragraph.push(lines[i++])
    if (paragraph.length === 0) paragraph.push(lines[i++])
    const k = next()
    out.push(<p key={k}>{inline(paragraph.join(' '), k)}</p>)
  }
  return out
}

export default function MarkdownView({ source }: { source: string }) {
  return (
    <div className="md" data-testid="markdown-view">
      {renderMarkdown(source)}
    </div>
  )
}
