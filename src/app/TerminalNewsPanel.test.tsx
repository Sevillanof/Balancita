// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import TerminalNewsPanel from './TerminalNewsPanel.tsx'
import { decodeTerminalNews, type TerminalNewsItem } from './useTerminalNews.ts'

afterEach(cleanup)

const sampleNews: TerminalNewsItem[] = [
  {
    id: 'n1',
    source: 'The Defiant',
    url: 'https://thedefiant.io/1',
    title: 'Ethereum L2 blobs reach new milestone',
    publishedAtMs: Date.UTC(2026, 9, 30, 14, 15),
    receivedAtMs: Date.UTC(2026, 9, 30, 14, 16),
    relevance: 'high',
    relevanceValue: 0.91,
    direction: 'bullish',
  },
  {
    id: 'n2',
    source: 'CoinDesk',
    url: 'https://coindesk.com/2',
    title: 'ETH validator queue steadies',
    publishedAtMs: Date.UTC(2026, 9, 30, 12, 30),
    receivedAtMs: Date.UTC(2026, 9, 30, 12, 31),
    relevance: 'medium',
    relevanceValue: 0.62,
    direction: 'neutral',
  },
  {
    id: 'n3',
    source: 'Decrypt',
    url: 'https://decrypt.co/3',
    title: 'DeFi yields compress slightly',
    publishedAtMs: Date.UTC(2026, 9, 30, 10, 0),
    receivedAtMs: Date.UTC(2026, 9, 30, 10, 1),
    relevance: 'low',
    relevanceValue: 0.31,
    direction: 'bearish',
  },
  {
    id: 'n4',
    source: 'Cointelegraph',
    url: 'https://cointelegraph.com/4',
    title: 'Macro wrap for October 29',
    publishedAtMs: Date.UTC(2026, 9, 29, 18, 45),
    receivedAtMs: Date.UTC(2026, 9, 29, 18, 46),
    relevance: 'none',
    relevanceValue: 0.08,
    direction: null,
  },
]

describe('TerminalNewsPanel', () => {
  it('shows 3 news items per page with their relevance grade, paginates, and searches by date/time', () => {
    render(<TerminalNewsPanel items={sampleNews} loaded={true} />)
    const list = screen.getByRole('list', { name: 'Lista de noticias' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('Relevancia Alta 91%')).toBeTruthy()
    expect(screen.getByText('Relevancia Media 62%')).toBeTruthy()
    expect(screen.getByText('Relevancia Baja 31%')).toBeTruthy()
    expect(screen.getByText('1 / 2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Relevancia Nula 8%')).toBeTruthy()
    expect(screen.getByText('29/10 18:45')).toBeTruthy()

    const search = screen.getByRole('searchbox', {
      name: 'Buscar noticia por fecha u hora',
    })
    fireEvent.change(search, { target: { value: '30/10 14:15' } })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(
      screen.getByText('Ethereum L2 blobs reach new milestone'),
    ).toBeTruthy()
  })

  it('decodes valid /api/news payloads and discards malformed entries', () => {
    const decoded = decodeTerminalNews({
      status: 'ok',
      items: [
        {
          id: 'h1',
          source: 'Blockworks',
          url: 'https://blockworks.co/a',
          title: 'ETH ETF inflows',
          published_at_ms: 1000,
          received_at_ms: 1100,
          relevance: 'high',
          relevance_value: 0.88,
          direction: 'bullish',
        },
        { id: 'bad', relevance: 'invalid' },
      ],
    })
    expect(decoded).toHaveLength(1)
    expect(decoded[0]?.relevance).toBe('high')
  })
})
