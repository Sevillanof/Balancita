import { describe, expect, it } from 'vitest'
import { NEWS_FIXTURES } from './news-fixtures'

describe('news fixtures', () => {
  it('provides a non-empty, deterministic list', () => {
    expect(NEWS_FIXTURES.length).toBeGreaterThan(0)
    const ids = NEWS_FIXTURES.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every item a source, title, url and ISO publishedAt', () => {
    for (const item of NEWS_FIXTURES) {
      expect(item.source.trim()).not.toBe('')
      expect(item.title.trim()).not.toBe('')
      expect(item.url).toMatch(/^https:\/\//)
      expect(Number.isNaN(Date.parse(item.publishedAt))).toBe(false)
    }
  })

  it('only uses reserved .test hosts, so fixtures are never real news', () => {
    for (const item of NEWS_FIXTURES) {
      expect(new URL(item.url).hostname.endsWith('.test')).toBe(true)
    }
  })
})
