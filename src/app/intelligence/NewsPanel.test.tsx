import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import NewsPanel from './NewsPanel'
import { NEWS_FIXTURES } from './news-fixtures'

describe('NewsPanel', () => {
  it('renders every fixture with its source, time and link', () => {
    render(<NewsPanel status="ready" items={NEWS_FIXTURES} />)

    const region = screen.getByRole('region', { name: 'Noticias BTC-EUR' })
    expect(within(region).getAllByRole('listitem')).toHaveLength(
      NEWS_FIXTURES.length,
    )

    const first = NEWS_FIXTURES[0]!
    expect(within(region).getByText(first.source)).toBeInTheDocument()
    expect(
      within(region).getByRole('link', { name: first.title }),
    ).toHaveAttribute('href', first.url)
    expect(within(region).getByText('11:32')).toBeInTheDocument()
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

    expect(screen.getByText('Desactualizadas')).toBeInTheDocument()
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
})
