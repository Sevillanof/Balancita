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
- Delivery strategy: `ask-on-risk`; `stacked-to-main` selected on 2026-09-21
  after the completed scope reached 448 authored changed lines.

## Tasks

- [x] **BI-1 — Define repository skill**: create the concise runtime contract and register project discovery.
- [x] **BI-2 — Document runtime roadmap**: explain the staged architecture, technical-analysis foundations, news trust model, forecast ledger, evaluation metrics, risks, and acceptance gates.
- [x] **BI-3 — Validate and index**: run structural/frontmatter/link checks, Prettier, refresh `.atl/skill-registry.md`, and verify unrelated changes remain untouched.

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
- BI-2: created `docs/bitcoin-market-intelligence-roadmap.md` (server-side
  target architecture, freshness/latency definitions, technical-analysis
  foundation, `ForecastRecord` schema, evaluation methodology, news trust
  model, phased plan A–I, testing strategy, risks, decisions pending, and a
  dated verified-sources section). No file under `doc/**`,
  `docs/implementation-progress.md`,
  `docs/analisis-general-y-proximos-pasos.md`, `src/**`, `server/**`,
  `AGENTS.md`, or the skill was touched. `pnpm exec prettier --check
docs/bitcoin-market-intelligence-roadmap.md odd/tasks/bitcoin-intelligence-skill.md`
  passed after one write-format pass on the roadmap file (initial check
  failed on Markdown table column alignment only).
- RDD mode: enabled globally.
- Work-unit commits: BI-1 `4cc0627`; BI-2 `3bb4878`; BI-3 `3005764`; delivery
  evidence `fee07d0`.
- RDD: risk assessment was unavailable because the provider binary/fallback was
  missing. Native preflight confirmed that the pre-existing untracked analysis
  document was excluded from the candidate; the bounded assessment still could
  not run without its provider. No approval or receipt is claimed.
- BI-3: refreshed `.atl/skill-registry.md` with 14 skills; the project skill is
  indexed with its corrected 156-character description. Frontmatter parses,
  the skill name matches its folder, metadata and license are present, required
  sections are ordered, all relative links resolve, Prettier and diff checks
  pass, and VS Code reports no diagnostics.
- Delivery: 448 authored changed lines across the completed feature scope exceed
  the approximate 400-line review budget. The user selected `stacked-to-main`;
  no pull request or push is authorized by that choice.

## Next step

After explicit implementation authorization, begin roadmap phases A and B with
strict TDD.
