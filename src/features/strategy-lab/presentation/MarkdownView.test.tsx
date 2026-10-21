import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MarkdownView from './MarkdownView.tsx'

describe('MarkdownView', () => {
  it('renders headings, lists, quotes, tables, code and emphasis', () => {
    render(
      <MarkdownView
        source={[
          '# Título',
          '',
          '<sub>`id-v1` · práctica</sub>',
          '',
          '## ✅ PASA',
          '',
          '- uno **fuerte**',
          '- dos _suave_ con z_min y sqrt_bars',
          '',
          '> ⚠️ aviso',
          '',
          '| Col | Otra |',
          '| --- | --- |',
          '| 1,5 % | x |',
          '',
          '```json',
          '{"a": 1}',
          '```',
        ].join('\n')}
      />,
    )
    expect(
      screen.getByRole('heading', { level: 2, name: 'Título' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: '✅ PASA' }),
    ).toBeInTheDocument()
    expect(screen.getByText('id-v1').tagName).toBe('CODE')
    expect(screen.getByText('fuerte').tagName).toBe('STRONG')
    expect(screen.getByText('suave').tagName).toBe('EM')
    expect(screen.getByText(/z_min y sqrt_bars/)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(
      screen.getByRole('columnheader', { name: 'Col' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '1,5 %' })).toBeInTheDocument()
    expect(screen.getByText('{"a": 1}').closest('pre')).not.toBeNull()
    expect(screen.queryByText(/<sub>/)).toBeNull()
  })

  it('never turns text into HTML or links', () => {
    const { container } = render(
      <MarkdownView
        source={'<script>alert(1)</script> [x](javascript:alert(1)) <b>hi</b>'}
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container).toHaveTextContent('<script>alert(1)</script>')
  })
})
