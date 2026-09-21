# Bitcoin intelligence skill

## Objective

Create a repository-only skill and a human roadmap for evolving Balancita into a BTC-EUR intelligence workspace with timely quotes, trustworthy news, technical analysis, probabilistic estimates, and honest historical evaluation.

## Problem and why

The application has real read-only BTC-EUR quotes, a single-screen paper dashboard, deterministic analysis, and optional Gemini. It does not yet have a runtime pipeline for intraday candles, news ingestion, forecast provenance, or outcome scoring. An agent skill can govern future implementation, but it cannot replace that runtime orchestration.

## Authorized scope

- Add one project skill under `.github/skills/`.
- Register it in a root `AGENTS.md` and the local skill registry.
- Add one new roadmap under `docs/`.
- Do not edit either immutable file under `doc/`.
- Do not add market/news providers, credentials, trading automation, or runtime application code.

## Constraints

- BTC-EUR only for the first intelligence pipeline.
- Estimates are probabilistic and educational, never promises or order authority.
- News must retain source, URL, publication time, ingestion time, and licensing evidence.
- Forecasts must be immutable before outcomes and evaluated without look-ahead bias.
- Existing user changes in `docs/implementation-progress.md` and `src/domain/analysis.ts` must remain intact.
- Strict TDD source: repository/global instructions. For documentation and skill contracts, RED is the observed absence of the required files; checks are structural validation and Prettier.
- Delivery strategy: `ask-on-risk`; forecast below 400 authored changed lines.

## Tasks

- [x] **BI-1 — Define repository skill**: create the concise runtime contract and register project discovery.
- [ ] **BI-2 — Document runtime roadmap**: explain the staged architecture, technical-analysis foundations, news trust model, forecast ledger, evaluation metrics, risks, and acceptance gates.
- [ ] **BI-3 — Validate and index**: run structural/frontmatter/link checks, Prettier, refresh `.atl/skill-registry.md`, and verify unrelated changes remain untouched.

## Acceptance criteria

- The skill activates on Bitcoin/BTC-EUR market intelligence, real-time quotes/news, technical analysis, forecasts, and forecast evaluation tasks.
- The skill requires official-provider research, measurable freshness, provenance, no look-ahead, deterministic baselines, and no automatic orders.
- The roadmap distinguishes agent workflow orchestration from application runtime orchestration.
- The roadmap defines incremental stages and measurable exit criteria before implementation.
- All references resolve locally and Markdown formatting passes.

## Verification

- `pnpm exec prettier --check AGENTS.md .github/skills/bitcoin-market-intelligence/SKILL.md docs/bitcoin-market-intelligence-roadmap.md odd/tasks/bitcoin-intelligence-skill.md`
- Frontmatter and local-link structural validation.
- `git status --short` and scoped diffs.

## Progress

- RED observed: no `AGENTS.md`, no project-local skill, no `odd/tasks/`, and no Bitcoin intelligence roadmap existed before this work.

## Evidence

- BI-1: created `.github/skills/bitcoin-market-intelligence/SKILL.md` and root `AGENTS.md`; frontmatter, required section order, trigger coverage, and Prettier check passed. The roadmap link remains a forward reference until BI-2.
- RDD mode: enabled globally; candidate assessment runs after the BI-1 work-unit commit.

## Next step

Implement BI-2.
