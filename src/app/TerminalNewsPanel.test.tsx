// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalNewsPanel from './TerminalNewsPanel.tsx'
import {
  decodeTerminalNews,
  type TerminalNewsBriefing,
  type TerminalNewsItem,
} from './useTerminalNews.ts'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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

const briefing: TerminalNewsBriefing = {
  status: 'ok',
  product: 'PF_ETHUSD',
  text: 'Síntesis de prueba: las noticias no confirman un catalizador único para Ethereum.',
  knownAtMs: Date.UTC(2026, 9, 30, 15),
  checkedAtMs: Date.UTC(2026, 9, 30, 15, 1),
  expiresAtMs: Date.UTC(2026, 9, 30, 16),
  sourceCount: 1,
  sources: [
    {
      id: 'n1',
      source: 'The Defiant',
      url: sampleNews[0]!.url,
      publishedAtMs: sampleNews[0]!.publishedAtMs,
      receivedAtMs: sampleNews[0]!.receivedAtMs,
      licenseStatus: 'unknown',
    },
  ],
  reason: null,
}

describe('TerminalNewsPanel', () => {
  it('uses measured capacity, preserves Qwen across pages, and recalculates on resize', () => {
    let available = 282
    const resize: TestResizeObserver[] = []
    class TestResizeObserver implements ResizeObserver {
      private callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        resize.push(this)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      notify() {
        this.callback([], this)
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        return new DOMRect(
          0,
          0,
          280,
          this.getAttribute('data-testid') === 'news-available-space'
            ? available
            : this.tagName === 'LI'
              ? 50
              : 0,
        )
      },
    )
    const items = Array.from({ length: 7 }, (_, index) => ({
      ...sampleNews[0]!,
      id: `fit-${index}`,
      title: `Titular ${index}`,
    }))
    render(
      <TerminalNewsPanel
        viewport
        items={items}
        briefing={briefing}
        nowMs={briefing.checkedAtMs}
      />,
    )
    const list = screen.getByRole('list', { name: 'Lista de noticias' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(
      screen.getByRole('region', { name: 'Qwen, resumen de noticias' }),
    ).toHaveTextContent(briefing.text!)
    available = 108
    act(() => resize.forEach((observer) => observer.notify()))
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('2 / 4')).toBeTruthy()
  })
  it('pins only a real Qwen news summary above search results', () => {
    render(
      <TerminalNewsPanel
        viewport
        items={sampleNews}
        briefing={briefing}
        nowMs={briefing.checkedAtMs}
        source={{
          state: 'ok',
          collectorStatus: 'ok',
          collectorReason: null,
          policy: 'priority_v2',
        }}
      />,
    )
    const summary = screen.getByRole('region', {
      name: 'Qwen, resumen de noticias',
    })
    expect(summary).toHaveTextContent(briefing.text!)
    fireEvent.click(screen.getByRole('button', { name: 'Buscar noticias' }))
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'sin coincidencias' },
    })
    expect(summary).toHaveTextContent(briefing.text!)
    expect(screen.getByText(/Sin noticias para/)).toBeTruthy()
  })

  it('does not present an expired or disconnected Qwen summary as current', () => {
    render(
      <TerminalNewsPanel
        viewport
        items={[]}
        briefing={briefing}
        nowMs={briefing.expiresAtMs! + 1}
        source={{ state: 'error', reason: 'Disconnected' }}
      />,
    )
    expect(
      screen.getByRole('region', { name: 'Qwen, resumen de noticias' }),
    ).toHaveTextContent('Sin confirmar')
  })

  it('shows an explicit pending first card instead of invented Qwen prose', () => {
    render(<TerminalNewsPanel viewport items={[]} />)
    expect(
      screen.getByRole('region', { name: 'Qwen, resumen de noticias' }),
    ).toHaveTextContent('Pendiente')
    expect(screen.getByText(/Todavía no hay una síntesis/)).toBeTruthy()
  })
  it('shows only Baja, Media and Alta in the approved side card, preserving processing visibility', () => {
    render(
      <TerminalNewsPanel
        relevantOnly
        items={[
          ...sampleNews,
          {
            ...sampleNews[0]!,
            id: 'waiting',
            relevance: null,
            analysisStatus: 'pending',
          },
        ]}
      />,
    )
    expect(screen.getByText('Relevancia Alta')).toBeTruthy()
    expect(screen.getByText('Relevancia Media')).toBeTruthy()
    expect(screen.getByText('Relevancia Baja')).toBeTruthy()
    expect(screen.queryByText('Macro wrap for October 29')).toBeNull()
    expect(screen.getByText(/1 pendiente/)).toBeTruthy()
  })

  it('distinguishes expired news and does not present relevance as a probability of profit', () => {
    render(
      <TerminalNewsPanel
        items={[
          { ...sampleNews[0]!, expiresAtMs: Date.UTC(2026, 9, 30, 14, 30) },
        ]}
        loaded={true}
        nowMs={Date.UTC(2026, 9, 30, 15)}
      />,
    )
    expect(screen.getByText(/Vencida/)).toBeTruthy()
    expect(screen.queryByText(/91%/)).toBeNull()
  })

  it('keeps a received-but-unclassified item visible as pending', () => {
    const items = decodeTerminalNews({
      status: 'ok',
      items: [
        {
          id: 'pending',
          source: 'Fixture',
          url: 'https://example.invalid/test',
          title: 'Noticia pendiente',
          received_at_ms: 1000,
          published_at_ms: 900,
          relevance: null,
          direction: null,
          analysis_status: 'pending',
        },
      ],
    })
    expect(items).toHaveLength(1)
    render(<TerminalNewsPanel items={items} loaded={true} nowMs={1100} />)
    expect(screen.getByText(/Pendiente/)).toBeTruthy()
  })

  it('shows 3 news items per page with their relevance grade, paginates, and searches by date/time', () => {
    render(<TerminalNewsPanel items={sampleNews} loaded={true} />)
    const list = screen.getByRole('list', { name: 'Lista de noticias' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('Relevancia Alta')).toBeTruthy()
    expect(screen.getByText('Relevancia Media')).toBeTruthy()
    expect(screen.getByText('Relevancia Baja')).toBeTruthy()
    expect(screen.getByText('1 / 2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Relevancia Nula')).toBeTruthy()
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
