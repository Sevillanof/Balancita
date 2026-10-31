import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
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
  const dir = mkdtempSync(join(process.cwd(), '.balancita-news-test-'))
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

  const BRIEFING_TEXT =
    'La actividad de Ethereum y las novedades regulatorias concentran las noticias recientes, sin una señal de operación.'
  const BRIEFING_NOW = 1_793_460_000_000

  function seedBriefing(path: string, changes: Record<string, unknown> = {}) {
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_futures_news_briefings(
        briefing_id INTEGER PRIMARY KEY, briefing_version TEXT, product TEXT,
        status TEXT, started_at_ms INTEGER, known_at_ms INTEGER, expires_at_ms INTEGER,
        input_hash TEXT, inputs_json TEXT, model_ref TEXT, model_info_json TEXT,
        prompt_hash TEXT, prompt_version INTEGER, text TEXT, response_json TEXT,
        latency_ms INTEGER, reason TEXT
      );
    `)
    const inputs = JSON.stringify([
      {
        id: 'h1',
        source_id: 'thedefiant',
        source: 'The Defiant',
        url: 'https://thedefiant.io/a',
        title: 'Ethereum governance update',
        summary: 'Ethereum community update',
        published_at_ms: BRIEFING_NOW - 120000,
        received_at_ms: BRIEFING_NOW - 60000,
        relevance_at_ms: BRIEFING_NOW - 1000,
        direction_at_ms: BRIEFING_NOW - 1000,
        relevance: 'medium',
        direction: 'neutral',
        license_status: 'unknown',
      },
    ])
    const row = {
      briefing_version: 'futures-news-briefing.v1',
      product: 'PF_ETHUSD',
      status: 'ok',
      started_at_ms: BRIEFING_NOW - 100,
      known_at_ms: BRIEFING_NOW,
      expires_at_ms: BRIEFING_NOW + 900000,
      input_hash: createHash('sha256').update(inputs).digest('hex'),
      inputs_json: inputs,
      model_ref: 'Qwen-local.gguf',
      model_info_json: JSON.stringify({
        model_ref: 'Qwen-local.gguf',
        props: null,
      }),
      prompt_hash: 'a'.repeat(64),
      prompt_version: 1,
      text: BRIEFING_TEXT,
      response_json: JSON.stringify({
        model: 'Qwen-local.gguf',
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ summary: BRIEFING_TEXT }) },
          },
        ],
      }),
      latency_ms: 42,
      reason: null,
      ...changes,
    }
    const columns = Object.keys(row)
    db.prepare(
      `INSERT INTO paper_futures_news_briefings(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    ).run(...(Object.values(row) as (string | number | null)[]))
    db.close()
  }

  describe('stored Qwen news briefing', () => {
    it.each([1, 2])(
      'reads known prompt version %s without relaxing summary validation',
      (prompt_version) => {
        const path = seedNewsDb()
        seedBriefing(path, { prompt_version })
        expect(
          createNewsItems({
            newsDbPath: path,
            clock: () => BRIEFING_NOW,
          }).list(),
        ).toMatchObject({
          status: 'ok',
          briefing: { status: 'ok', text: BRIEFING_TEXT },
        })
        seedBriefing(path, {
          prompt_version,
          text: 'Ethereum news remains focused on crypto security.',
        })
        expect(
          createNewsItems({
            newsDbPath: path,
            clock: () => BRIEFING_NOW,
          }).list(),
        ).toMatchObject({
          status: 'ok',
          briefing: {
            status: 'error',
            text: null,
            reason: 'invalid_briefing_record',
          },
        })
      },
    )

    it('reports legacy or empty tables as pending without fabricating Qwen text', () => {
      const path = seedNewsDb()
      const result = createNewsItems({
        newsDbPath: path,
        clock: () => BRIEFING_NOW,
      }).list()
      expect(result).toMatchObject({
        status: 'ok',
        briefing: {
          status: 'pending',
          product: 'PF_ETHUSD',
          text: null,
          known_at_ms: null,
          checked_at_ms: BRIEFING_NOW,
          source_count: 0,
          sources: [],
          reason: 'briefing_not_recorded',
        },
      })
      if (result.status === 'ok')
        expect(result.briefing.expires_at_ms).toBeUndefined()
    })

    it('reads exactly the persisted synthesis with provenance, never changing news or classifier rows', () => {
      const path = seedNewsDb()
      seedBriefing(path)
      const before = new DatabaseSync(path, { readOnly: true })
      const items = before
        .prepare('SELECT * FROM paper_futures_news_items')
        .all()
      const analyses = before
        .prepare('SELECT * FROM paper_futures_news_analysis')
        .all()
      before.close()
      expect(
        createNewsItems({
          newsDbPath: path,
          clock: () => BRIEFING_NOW + 1,
        }).list(),
      ).toMatchObject({
        status: 'ok',
        briefing: {
          status: 'ok',
          product: 'PF_ETHUSD',
          text: BRIEFING_TEXT,
          known_at_ms: BRIEFING_NOW,
          checked_at_ms: BRIEFING_NOW + 1,
          source_count: 1,
          sources: [
            {
              id: 'h1',
              source: 'The Defiant',
              url: 'https://thedefiant.io/a',
              published_at_ms: BRIEFING_NOW - 120000,
              received_at_ms: BRIEFING_NOW - 60000,
              license_status: 'unknown',
            },
          ],
          reason: null,
          model_ref: 'Qwen-local.gguf',
          expires_at_ms: BRIEFING_NOW + 900000,
        },
      })
      const after = new DatabaseSync(path, { readOnly: true })
      expect(
        after.prepare('SELECT * FROM paper_futures_news_items').all(),
      ).toEqual(items)
      expect(
        after.prepare('SELECT * FROM paper_futures_news_analysis').all(),
      ).toEqual(analyses)
      after.close()
    })

    it('does not relabel stale text or future knowledge as a current Qwen summary', () => {
      const path = seedNewsDb()
      seedBriefing(path)
      expect(
        createNewsItems({
          newsDbPath: path,
          clock: () => BRIEFING_NOW + 900000,
        }).list(),
      ).toMatchObject({
        status: 'ok',
        briefing: { status: 'stale', text: null, reason: 'briefing_expired' },
      })
      expect(
        createNewsItems({
          newsDbPath: path,
          clock: () => BRIEFING_NOW - 1,
        }).list(),
      ).toMatchObject({
        status: 'ok',
        briefing: { status: 'pending', text: null, source_count: 0 },
      })
    })

    it.each([
      ['pending', 'generation_in_progress'],
      ['no_news', 'no_recent_analyzed_news'],
      ['off', 'briefing_disabled'],
      ['error', 'malformed_response'],
    ] as const)(
      'surfaces the explicit %s state, with no fallback summary',
      (status, reason) => {
        const path = seedNewsDb()
        seedBriefing(path, {
          status,
          reason,
          text: null,
          response_json: null,
          ...(status === 'off' || status === 'no_news'
            ? {
                inputs_json: '[]',
                input_hash: createHash('sha256').update('[]').digest('hex'),
              }
            : {}),
        })
        expect(
          createNewsItems({
            newsDbPath: path,
            clock: () => BRIEFING_NOW,
          }).list(),
        ).toMatchObject({
          status: 'ok',
          briefing: { status, text: null, reason },
        })
      },
    )

    it.each([
      { inputs_json: '[not json]' },
      { input_hash: 'tampered' },
      { text: ' '.repeat(201) },
      { text: 'Compra Ethereum ahora.' },
      { response_json: '{}' },
      { model_ref: 'another-model.gguf' },
      { prompt_version: 3 },
    ])(
      'isolates malformed briefing rows from the existing news list: %j',
      (changes) => {
        const path = seedNewsDb()
        seedBriefing(path, changes)
        expect(
          createNewsItems({ newsDbPath: path, clock: () => BRIEFING_NOW }).list(
            1,
          ),
        ).toMatchObject({
          status: 'ok',
          items: [{ id: 'h3' }],
          briefing: {
            status: 'error',
            text: null,
            reason: 'invalid_briefing_record',
          },
        })
      },
    )
  })
})
