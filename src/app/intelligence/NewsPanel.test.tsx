import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import NewsPanel from './NewsPanel'
import { NEWS_FIXTURES, type NewsItem } from './news-fixtures'

describe('NewsPanel', () => {
  it('renders every fixture with its source, time and link', () => {
    render(<NewsPanel status="ready" items={NEWS_FIXTURES} />)

    const region = screen.getByRole('region', { name: 'Noticias BTC-EUR' })
    expect(within(region).getAllByRole('listitem')).toHaveLength(
      NEWS_FIXTURES.length,
    )
    expect(
      within(region).queryByRole('heading', {
        name: 'NOTICIAS EN TIEMPO REAL',
      }),
    ).not.toBeInTheDocument()
    expect(
      region.querySelector('#dashboard-news-title'),
    ).not.toBeInTheDocument()

    const first = NEWS_FIXTURES[0]!
    expect(within(region).getByText(first.source)).toBeInTheDocument()
    expect(
      within(region).getByRole('link', { name: first.title }),
    ).toHaveAttribute('href', first.url)
    expect(within(region).getByText('11:32')).toBeInTheDocument()
  })

  it('sorts newest first and exposes importance before each time', () => {
    const items: readonly NewsItem[] = [
      {
        ...NEWS_FIXTURES[0]!,
        id: 'older',
        publishedAt: '2026-09-22T10:00:00.000Z',
        important: false,
      },
      {
        ...NEWS_FIXTURES[0]!,
        id: 'newer',
        publishedAt: '2026-09-22T12:00:00.000Z',
        important: true,
      },
    ]

    render(<NewsPanel status="ready" items={items} />)

    const listItems = screen.getAllByRole('listitem')
    expect(within(listItems[0]!).getByRole('link')).toHaveAttribute(
      'href',
      items[1]!.url,
    )
    expect(
      within(listItems[0]!).getByLabelText('Importante'),
    ).toBeInTheDocument()
    expect(within(listItems[0]!).getByText('12:00')).toBeInTheDocument()
    expect(
      within(listItems[1]!).getByLabelText('No importante'),
    ).toBeInTheDocument()
    expect(within(listItems[1]!).getByText('10:00')).toBeInTheDocument()
  })

  it('exposes an accessible loading state without layout surprises', () => {
    render(<NewsPanel status="loading" items={[]} />)

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveTextContent('Cargando noticias')
  })

  it('shows an empty state when there are no items', () => {
    render(<NewsPanel status="empty" items={[]} />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'No hay noticias disponibles',
    )
  })

  it('shows an error state with a retry control', async () => {
    const onRetry = vi.fn()
    render(<NewsPanel status="error" items={[]} onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'No se pudieron cargar las noticias',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('marks stale news without hiding the items', () => {
    render(<NewsPanel status="stale" items={NEWS_FIXTURES} />)

    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText(/Noticias desactualizadas/)).toBeInTheDocument()
    expect(screen.queryByText(/fixtures locales/i)).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(NEWS_FIXTURES.length)
  })

  it('never performs a network request while rendering', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network is disabled in tests')
    })

    render(<NewsPanel status="ready" items={NEWS_FIXTURES} />)

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('renders only the compact presentation fields for each item', () => {
    const item = {
      ...NEWS_FIXTURES[0]!,
      ingestedAt: '2026-09-20T11:33:00.000Z',
      displayedAt: '2026-09-20T11:34:00.000Z',
      licenseStatus: 'official_public' as const,
      freshness: { ageMs: 60_000, isStale: false },
    }

    render(
      <NewsPanel
        status="ready"
        items={[item]}
        now={() => Date.parse('2026-09-22T18:00:00.000Z')}
      />,
    )

    const region = screen.getByRole('region', { name: 'Noticias BTC-EUR' })
    const row = within(region).getByRole('listitem')
    expect(within(row).getByText(item.source)).toBeInTheDocument()
    expect(within(row).getByRole('link')).toHaveAttribute('href', item.url)
    expect(within(row).getByText(item.summary)).toBeInTheDocument()
    expect(within(row).getByText('Neutral')).toBeInTheDocument()
    expect(
      within(row).queryByText(/Publicado|Ingestado|Mostrado|Licencia/),
    ).not.toBeInTheDocument()
  })

  it('excludes yesterday and keeps the UTC day boundaries', () => {
    const item = NEWS_FIXTURES[0]!
    render(
      <NewsPanel
        status="ready"
        items={[
          item,
          { ...item, id: 'yesterday', publishedAt: '2026-09-21T23:59:59.999Z' },
          { ...item, id: 'boundary', publishedAt: '2026-09-23T00:00:00.000Z' },
        ]}
        now={() => Date.parse('2026-09-22T12:00:00.000Z')}
      />,
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })
})
