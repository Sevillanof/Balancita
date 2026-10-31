import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createNewsItems, newsItemsOff } from './news-items.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function seedNewsDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-news-'))
  dirs.push(dir)
  const path = join(dir, 'futures-news.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE paper_futures_news_items(
      item_id INTEGER PRIMARY KEY,
      item_hash TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      published_at INTEGER,
      received_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE TABLE paper_futures_news_analysis(
      analysis_id INTEGER PRIMARY KEY,
      item_hash TEXT NOT NULL,
      question_id TEXT NOT NULL,
      question_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      analyzed_at INTEGER NOT NULL,
      chosen TEXT,
      value REAL
    );
  `)
  db.prepare(
    `INSERT INTO paper_futures_news_items VALUES
      (1, 'h1', 'thedefiant', 'The Defiant', 'https://thedefiant.io/a', 'Ethereum L2 TVL hits record', 's1', 1000, 1100, 'c1'),
      (2, 'h2', 'coindesk', 'CoinDesk', 'https://coindesk.com/b', 'ETH staking update', 's2', 2000, 2100, 'c2'),
      (3, 'h3', 'decrypt', 'Decrypt', 'https://decrypt.co/c', 'Old stale headline', 's3', 3000, 3100, 'c3')`,
  ).run()
  db.prepare(
    `INSERT INTO paper_futures_news_analysis(item_hash, question_id, question_version, status, analyzed_at, chosen, value) VALUES
      ('h1', 'news_relevance_btc', 2, 'done', 1200, 'high', 0.92),
      ('h1', 'news_direction', 2, 'done', 1200, 'bullish', null),
      ('h2', 'news_relevance_btc', 2, 'done', 2200, 'medium', 0.58),
      ('h2', 'news_direction', 2, 'done', 2200, 'neutral', null),
      ('h3', 'news_relevance_btc', 2, 'skipped_stale', 3200, null, null)`,
  ).run()
  db.close()
  return path
}

describe('createNewsItems', () => {
  it('returns received news with actual analysis states and never invents a reuse license', () => {
    const path = seedNewsDb()
    const news = createNewsItems({ newsDbPath: path })
    const result = news.list(10)
    expect(result).toMatchObject({
      status: 'ok',
      items: [
        {
          id: 'h3',
          relevance: null,
          direction: null,
          analysis_status: 'stale',
          license_status: 'unknown',
        },
        {
          id: 'h2',
          source_id: 'coindesk',
          source: 'CoinDesk',
          url: 'https://coindesk.com/b',
          title: 'ETH staking update',
          published_at_ms: 2000,
          received_at_ms: 2100,
          relevance: 'medium',
          relevance_value: 0.58,
          direction: 'neutral',
          license_status: 'unknown',
          known_at_ms: 2200,
          analysis_version: 2,
        },
        {
          id: 'h1',
          source_id: 'thedefiant',
          source: 'The Defiant',
          url: 'https://thedefiant.io/a',
          title: 'Ethereum L2 TVL hits record',
          published_at_ms: 1000,
          received_at_ms: 1100,
          relevance: 'high',
          relevance_value: 0.92,
          direction: 'bullish',
          license_status: 'unknown',
          known_at_ms: 1200,
          analysis_version: 2,
        },
      ],
    })
  })

  it('validates limit and reports off when the database is missing', () => {
    const path = seedNewsDb()
    const news = createNewsItems({ newsDbPath: path })
    expect(news.list(0)).toEqual({ status: 'error', reason: 'invalid_limit' })
    expect(news.list(1)).toMatchObject({ status: 'ok', items: [{ id: 'h3' }] })
    expect(createNewsItems({ newsDbPath: undefined }).list()).toEqual({
      status: 'off',
      reason: 'source_not_configured',
    })
    expect(newsItemsOff('disabled').list()).toEqual({
      status: 'off',
      reason: 'disabled',
    })
  })

  it('does not present an old BTC v1 analysis as an Ethereum classification', () => {
    const path = seedNewsDb()
    const db = new DatabaseSync(path)
    db.exec(`
        INSERT INTO paper_futures_news_items VALUES
          (4, 'btc-old', 'fixture', 'Fixture', 'https://example.invalid/old', 'Legacy BTC classification', '', 4000, 4100, 'c4');
        INSERT INTO paper_futures_news_analysis(item_hash,question_id,question_version,status,analyzed_at,chosen)
          VALUES ('btc-old','news_relevance_btc',1,'done',4200,'high'),
                 ('btc-old','news_direction',1,'done',4200,'bullish');
      `)
    db.close()
    expect(createNewsItems({ newsDbPath: path }).list(1)).toMatchObject({
      status: 'ok',
      items: [
        {
          id: 'btc-old',
          analysis_status: 'pending',
          analysis_version: null,
          relevance: null,
          direction: null,
        },
      ],
    })
  })

  it('reports fetch failures separately from a successfully readable cache', () => {
    const path = seedNewsDb()
    const db = new DatabaseSync(path)
    db.exec(`
        CREATE TABLE paper_futures_news_source_sets(source_set_id INTEGER PRIMARY KEY,sources_json TEXT,interval_ms INTEGER);
        CREATE TABLE paper_futures_news_polls(poll_id INTEGER PRIMARY KEY,source_set_id INTEGER,source_id TEXT,finished_at_ms INTEGER,status TEXT,detail TEXT);
        INSERT INTO paper_futures_news_source_sets VALUES (1,'[{"id":"thedefiant"},{"id":"coindesk"}]',300000);
        INSERT INTO paper_futures_news_polls VALUES (1,1,'thedefiant',4000,'ok',NULL),(2,1,'coindesk',4000,'error','HTTP 403');
      `)
    db.close()
    expect(
      createNewsItems({ newsDbPath: path, clock: () => 5000 }).list(),
    ).toMatchObject({
      status: 'ok',
      collection: { status: 'warning', failed_sources: ['coindesk'] },
    })
  })
})
