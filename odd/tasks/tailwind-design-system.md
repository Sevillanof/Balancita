# tailwind-design-system

Objective: one design system for the whole app, built on Tailwind CSS v4, where the app and the published design system come from the same tokens and the same components.
Branch: `feat/tailwind-design-system` (one branch per slice, chained). Delivery strategy: `ask-on-risk`. Test runner: `pnpm test` (Vitest), `pnpm test:e2e` (Playwright screens).

## Problem / why

- Two styling systems live side by side: `src/shared/styles/ui.css` (legacy light/dark, blue accent, 354 lines) and Mission Control (`src/shared/mission-control/mission-control.css`, 233 lines, the `--mc-*` tokens). All 11 screen stylesheets already use only `--mc-*`, while `ui.css` still styles every global button, input and table.
- About 4,100 lines of hand-written CSS across 13 files, each screen with its own selectors and values.
- The published design system (https://claude.ai/artifact/B3AvVBuQcwxr6o7CT2Fmze) is a hand copy of those files, with static previews. It drifts as soon as the code changes.

What this is NOT: a runtime performance fix. Plain CSS and Tailwind both ship static CSS. The "Terminal is slow" problem was a gateway SQLite query plan (fixed in commit 9365be8d), not styling. Runtime render cost in React is a separate topic.

## Target

```text
src/shared/design-system/theme.css   ← the ONLY token source (@theme)
        │
        ├── Tailwind utilities (bg-long, text-ink-2, p-4, rounded-sm …)
        │       └── src/shared/mission-control/*.tsx  ← shared components, styled with utilities
        │               ├── the app screens compose them
        │               └── design system bundle (bundle.js + bundle.css, Vite library build)
        └── scripts/design-system/export-tokens.mjs → design system tokens.json
```

## Specs

- **S1 — One system.** User: «El design system tiene que estar unificado. Tailwind puede ser la mejor opcion para unificarlo y hacerlo escalable?» Acceptance: one token source (`theme.css`); `ui.css`, `mission-control.css` and every screen `.css` file are deleted by the end; no `--color-*`/`--bg`/`--positive` legacy variables remain.
- **S2 — Clean and working.** User: «el css que tenemos hoy es feo y no tiene buen performance. Yo quiero algo limpio y que funcione bien.» Acceptance: pages compose shared components; utilities live inside components, not as long class strings in pages; no arbitrary values (`text-[13px]`, `w-[437px]`, `#hex` in `className`).
- **S3 — Semantic palette only.** From the design system brand book: color is semantic only (long, short, warn, info), and "Sin datos" is never green. Acceptance: Tailwind's default palette is removed (`--color-*: initial`), so `text-red-500` does not compile.
- **S4 — The design system comes from the code.** Acceptance: the published design system's `tokens.json`, `bundle.js` and `bundle.css` are generated from `theme.css` and the shared components by one command; previews render the real components live.
- **S5 — No visual regression (assumption, confirm with the user).** Each slice keeps the screens visually identical unless the slice says otherwise. Acceptance: Playwright screenshots of Terminal and Estrategias before and after each slice are reviewed side by side.
- **S6 — No runtime regression.** Acceptance: the Terminal still loads its bootstrap in ~0.1 s and shows no frame gaps over 50 ms when switching strategy (the 2026-10-23 measurements).

## Constraints

- Paper only; ADR 0001 is untouched. C25-C31 and Kronos strategy logic is not modified (styling only).
- **New dependencies need approval:** `tailwindcss` and `@tailwindcss/vite`, pinned to exact versions at install time (at least two weeks old). Nothing else.
- No CSS-in-JS with runtime cost (styled-components, Emotion).
- Chart colors: `ApprovedTerminalChart` reads CSS variables at runtime through `cssColor('--chart-up', …)`. Those variables must keep resolving after every slice.
- Existing test ids (`approved-trading-header`, …) and accessible names stay.

## Token mapping (Mission Control → Tailwind v4 `@theme`)

| Today                                                          | `@theme` variable                                                                                                       | Utility example                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `--mc-canvas` `#0a0d14`                                        | `--color-canvas`                                                                                                        | `bg-canvas`                                    |
| `--mc-surface-1` / `-2` / `-hover`                             | `--color-surface-1` / `-2` / `-hover`                                                                                   | `bg-surface-1`                                 |
| `--mc-border` / `-strong` / `-focus`                           | `--color-line` / `-strong` / `-focus`                                                                                   | `border-line`                                  |
| `--mc-long` / `--mc-short` / `--mc-warn` / `--mc-info`         | `--color-long` / `short` / `warn` / `info`                                                                              | `text-long`, `bg-long/10`, `border-long/25`    |
| `--mc-text` / `-2` / `-3`                                      | `--color-ink` / `ink-2` / `ink-3`                                                                                       | `text-ink-2`                                   |
| `--mc-on-long`                                                 | `--color-on-long`                                                                                                       | `text-on-long`                                 |
| `--mc-space-xs…xl` (4–24px)                                    | `--spacing: 4px`                                                                                                        | `p-1`=4, `p-2`=8, `p-3`=12, `p-4`=16, `p-6`=24 |
| `--mc-radius` 4px / `-lg` 8px                                  | `--radius-sm` / `--radius-lg`                                                                                           | `rounded-sm`                                   |
| `--mc-font` / `--mc-font-mono`                                 | `--font-sans` / `--font-mono`                                                                                           | `font-mono`                                    |
| 11px label, 12px hint, 13px, 14px body, 16px title, 20px value | `--text-label`, `--text-hint`, `--text-note`, `--text-body`, `--text-title`, `--text-value` (each with `--line-height`) | `text-label`                                   |
| `--mc-shadow-popover`                                          | `--shadow-popover`                                                                                                      | `shadow-popover`                               |

The status pill formula (10% fill, 25% border, full-strength text) becomes `bg-long/10 border-long/25 text-long`: Tailwind v4 builds opacity modifiers with `color-mix`, the same technique the CSS uses today.

`mc-text-3` is about 2.6:1 on the canvas. It keeps its decoration-only rule; the guard in T4 rejects it on text.

## Tasks

| ID  | Specs          | Route  | Status                          | Commit   |
| --- | -------------- | ------ | ------------------------------- | -------- |
| T1  | S1, S3, S5     | inline | done                            | d0162349 |
| T2  | S1, S2, S5     | inline | done                            | ce1f4a8f |
| T3  | S4             | inline | local done; publication pending | 292ff226 |
| T4  | S2, S3         | inline | done                            | 6b727b23 |
| T5  | S1, S2, S5, S6 | inline | in progress; T5a local done      | —        |
| T6  | S1, S2, S5, S6 | inline | pending                         | —        |
| T7  | S1, S2, S5     | inline | pending                         | —        |
| T8  | S1             | inline | pending                         | —        |

### T1 — Tailwind and the single theme (no visual change)

- Install `tailwindcss` and `@tailwindcss/vite`, add the plugin to `vite.config.ts`.
- Create `src/shared/design-system/theme.css`: `@import "tailwindcss";`, then `@theme { --color-*: initial; … }` with the mapping above. Load the fonts through `@font-face` from `@fontsource` (already installed).
- Keep compatibility aliases, so the not-yet-migrated CSS keeps working: `--mc-long: var(--color-long)` and so on, plus `--chart-up` / `--chart-down`.
- Import `theme.css` once from `src/main.tsx`. Delete the `:root` token block from `mission-control.css`.
- Check: `pnpm test`, `pnpm typecheck`, Playwright screens before/after, the dev bundle has no Tailwind default colors.
- Risk: item 5 (new build dependencies).

### T2 — Shared components on utilities

- Restyle `Panel`, `Metric`, `StatusPill`, `DataState`, `DataProvenance`, `TopBar` and `AppShell` with utilities. Variants (tone, kind) go in a plain object of class strings inside each component (no new dependency), never `@apply` chains.
- Delete their rules from `mission-control.css` and the header rules from `src/app/DemoShell.css`.
- Check: `src/shared/mission-control/mission-control.test.tsx` passes unchanged; screenshots match.

### T3 — Design system generated from the code

- `vite.design-system.config.ts`: library build of `src/shared/mission-control/index.ts`, format IIFE, global `Balancita`, `react` and `react-dom` external as `window.React` / `window.ReactDOM`, classic JSX runtime (`React.createElement`) so no `jsx-runtime` shim is needed. Output `bundle.js` (with the `@ds-bundle` header line) and `bundle.css` (Tailwind output for the shared components only).
- `scripts/design-system/export-tokens.mjs`: reads `theme.css` and writes the design system `tokens.json` (list shape, with the usage notes kept in a sidecar `tokens.usage.json`).
- `pnpm design-system:build` runs both. Live previews mount `window.Balancita.<Component>` with real props.
- Republish the artifact at https://claude.ai/artifact/B3AvVBuQcwxr6o7CT2Fmze (same URL), libraries `react` / `react-dom` 18.
- Check: every preview renders; tokens.json values equal `theme.css`.

#### T3 local workflow

```bash
pnpm design-system:build
pnpm design-system:test
pnpm design-system:verify
open dist/design-system/index.html
```

The generated directory is ignored by Git. Open the HTML directly; no server, new port, CDN or market connection is needed. Chrome must be installed for `design-system:verify`.

- `bundle.js` exposes `window.Balancita`. Load a host React and ReactDOM first; the component bundle does not embed either and uses classic `React.createElement`, not a version-specific JSX-runtime shim.
- `bundle.css` contains the theme, embedded fonts, shared-component utilities and temporary `--mc-*` aliases, not screen CSS. Tailwind scans only shared component TSX, excluding tests. As with the app's no-preflight setup, a host supplies base styles (box sizing, body margin, link defaults); the catalog provides its own document styling.
- `runtime.js` is separate and uses the project's installed React/ReactDOM (19.3.0 in this validation) for the offline catalog. It is not required when the host already provides those globals. React 18 runtime compatibility has **not** been validated; classic JSX removes the known element-format coupling but is not a substitute for that validation. Generated runtime/font license notices travel with the catalog.
- `tokens.json` is a list of `{ name, value, type }`; names omit the CSS `--` prefix. `tokens.usage.json` stores usage guidance separately. Both the catalog and its token search consume the generated values.
- Catalog HTML/JS live under `scripts/design-system/`; component examples instantiate the exported components, never hand-copied markup. The catalog's editorial layout does not change the app's visual design.
- Rebuilding refreshes the output directory. A normal app build also replaces `dist`, so rerun `design-system:build` afterward if needed.
- Republishing the existing external artifact is a manual user action, pending host/runtime verification. This task does not upload source or generated code to third-party services.

### T4 — Guard rails

- A Vitest test that scans `src/**/*.tsx` and fails on: arbitrary values in `className` (`-[`), raw hex colors, `ink-3` on text, and any new `.css` file other than `theme.css`. No new lint dependency.
- Check: the test fails on a fixture with each violation, passes on the codebase.

Run the focused guard suite with:

```bash
pnpm exec vitest run --dir src --exclude '.claude/**' --exclude '**/node_modules/**' src/shared/design-system/guardrails.test.ts
```

The test uses the existing TypeScript compiler to inspect JSX `className` values and reachable static strings (templates, branches, aliases, imported variant maps and class-helper arguments). It ignores comments, display text and unrelated strings such as chart colors. Tests/specs are excluded from the application-source scan so negative fixtures do not flag themselves. This is a static guard, not a runtime evaluator: classes assembled from arbitrary runtime data or custom function return values still require review.

Only `theme.css` and the 13 explicitly listed legacy source stylesheets are allowed. New or renamed CSS files under `src` fail; when retiring a legacy stylesheet, remove its entry from `LEGACY_CSS` in the same slice. Stale entries fail too, preventing retired paths from silently remaining exempt. The standalone T3 catalog is tooling under `scripts/design-system`, outside this app-source rule.

### T5 — Terminal screens

- Migrate `src/app/ConnectedTerminal.css` (404 lines), the rest of `src/app/DemoShell.css` (427) and `src/features/trading-view/presentation/terminal-chart-panel.css` (324). Delete each file when its screen is done.
- Check: screenshots; S6 measurements (bootstrap time, frame gaps).

T5 is split into independently reviewable units because its starting scope is
1,011 CSS lines plus the component consumers:

| Unit | Scope | Status |
| ---- | ----- | ------ |
| T5a | Market strip, shared notices, product select, loading/error frame and usage chip | Local done; pending user commit |
| T5b | Chart toolbar, statistics, details and responsive panes | Pending |
| T5c | Terminal layout, account/history tables and decisions; retire remaining stylesheets | Pending |

T5a uses one `TerminalNotices` component for both market alerts and the gateway
diagnosis. Unknown/no-data tones stay neutral. The usage chip owns its alignment,
so observability no longer needs a badge-specific override. Existing accessible
labels, price formatting, evidence titles, polling and product-switch logic are
unchanged.

The product select temporarily needs important utilities: unlayered `ui.css`
still sets every native select's height, padding, colors, border, font and focus
outline. T8 can remove these modifiers with that legacy layer. New badge,
tracking and control-line-height tokens preserve the existing visual values;
they are not new styling rules copied into the theme. Keep the three T5 CSS
allowlist entries until T5b/T5c actually delete those files.

### T6 — Estrategias screens

- Migrate `StrategiesPage.css` (146), `StrategyLab.css` (5), `StrategyModals.css` (185), `StrategyRunView.css` (491), `AnalyzerModal.css` (254), `VectorbtPanel.css` (261) under `src/features/strategy-lab/presentation/`.
- Check: screenshots; strategy switch shows no frame gap over 50 ms.

### T7 — Observability screens

- Migrate `observability.css` (619) and `decisions.css` (411) under `src/features/observability/presentation/`.
- Check: screenshots.

### T8 — Retire the legacy layer

- Delete `src/shared/styles/ui.css`, `mission-control.css` and the `--mc-*` / legacy aliases. Laboratorio and Investigación pages move to the shared components (or utilities) in this slice.
- Check: a grep for `var(--mc-`, `var(--color-background`, `var(--bg` returns nothing; full suite and screenshots.
- Risk: item 3 if any page outside the app still imports `ui.css` (check first).

## Delivery

Each task or explicitly named sub-unit is one work-unit commit; report slices over ~400 authored changed lines rather than compressing them. The assistant only edits and validates: the user runs all branch, commit, push and PR commands. Per the user's 2026-10-26 instruction, commit commands for this work omit the Copilot co-author trailer.

## Log

- **L1 (2026-10-23, user, verbatim):** «Hablemos en espeañol. Pensemos con cual lo podemos hacer, si no es tailwing» · «Tambien el plan es dejar de usar css plano, y empezar a usar otra cosa, pensaba en tailwing? Que decis vos? Se critico» · «Lo que me molesta es que el css que tenemos hoy es feo y no tiene buen performance. Yo quiero algo limpio y que funcione bien.» · «El design system tiene que estar unificado. Tailwind puede ser la mejor opcion para unificarlo y hacerlo escalable?» · «Escribime un archivo .md para implementarlo.»
- **L2 (2026-10-23, evidence):** CSS audit: 11 potentially expensive properties across 13 files, all screen CSS uses only `--mc-*`. The Terminal slowness was the gateway (85% of CPU in two SQLite tails), fixed in 9365be8d; CPU ~65% → ~4%, bootstrap ~0.1 s.
- **L3 (2026-10-23, decision):** Rust migration not recommended (about 158k lines, the Python engine ecosystem, and the ADR freeze on C25-C31 and Kronos). Tailwind v4 accepted as the unification tool, under the rules in S2 and S3.
- **L4 (2026-10-23, T1 done):** `tailwindcss` and `@tailwindcss/vite` 4.3.3 pinned. Deviations from the T1 text, all forced by the unlayered `ui.css` that lives until T8:
  - Only `tailwindcss/theme.css` and `utilities.css` are imported; no preflight, because it would change the visuals while `ui.css` exists.
  - `--font-*` and `--radius-*` use `@theme inline`, because `ui.css` redefines `--font-sans`, `--radius-sm` and `--radius-lg` on `:root`. The `--text-*`, `--leading-*` and `--shadow-*` namespaces are reset to `initial` for the same reason.
  - The `:root` block in `mission-control.css` is not deleted; it becomes `--mc-*` aliases to the theme. `--mc-font`, `--mc-font-mono`, `--mc-radius` and `--mc-radius-lg` stay literal because of that collision.
  - No `--chart-up` / `--chart-down` aliases: they were never defined, and the chart uses its fallbacks, so defining them would change the colors.
  - Fonts moved from `AppShell.tsx` to `theme.css`.
- **L4 checks:** computed styles identical before and after (391 elements in Terminal, 191 in Estrategias, 0 differences, same fonts loaded). The build has no default palette (`red-500` is absent). tsc, eslint and 483/483 tests pass.
- **L5 (2026-10-23, performance, measured before T1):** 60 s in Terminal with live data, prod build: CPU 3.2%, 60 FPS, 0 long tasks. The main cost was the chart's price formatter, which created an `Intl.NumberFormat` on every call. Caching it in `src/shared/finance/format.ts` cut formatter time from ~656 ms to ~9 ms. Rust/WASM is not needed.
- **L6 (2026-10-26, T2 done):** `Panel`, `Metric`, `StatusPill`, `DataState`, `DataProvenance`, `TopBar` and the `AppShell` frame use semantic Tailwind utilities. Removed 193 lines of component CSS and 156 lines from `DemoShell.css`. `Metric` is retained as specified by T2; its removal is not part of this migration.
  - Added semantic brand/provenance typography, tracking, brand radius and shell-width tokens/utilities. Named header variants preserve the inclusive 1080/760/640/460px breakpoints, including the exact boundary widths. No arbitrary sizing/color values in `className`, new dependencies or strategy logic changes.
  - `TerminalEntry`'s loading/error frame gets the same shell utilities because it shared the removed root styles. Legacy link/reset/font-feature rules and screen-owned badge/select rules remain until T5/T8. `demo-shell__status` remains a hook for the selector CSS and existing tests.
  - Without preflight, a side-only border must use `border-b-solid`, not `border-solid`: the latter also enables the browser's default medium borders on the other sides.
- **L6 checks:** production builds compared in headless Chrome through the existing localhost port, with the same captured public-market snapshot and GET responses replayed to both versions. Terminal (395 elements), Estrategias (191), and a component fixture (112, including all tones, data states and known/unknown provenance) compared at 1600/1081/1080/761/760/641/640/461/460/390px, in normal, navigation hover/focus and product-selector focus states: zero computed visual-style/geometry differences after normalizing equivalent color syntax and ignoring non-rendered border colors and the equivalent header max-width constraint. Screenshots reviewed: Estrategias is byte-identical at all 10 widths; pills have at most one channel level of pixel rounding from srgb vs oklab interpolation, and two chart pixels at 1081px differ by at most three levels. No browser runtime errors. No new ports or server restarts.
  - Focused validation: `npx vitest run --dir src --exclude '.claude/**' --exclude '**/node_modules/**' src/shared/mission-control/mission-control.test.tsx src/app/FuturesTerminal.test.tsx src/app/TerminalEntry.test.tsx src/features/strategy-lab/presentation/StrategiesPage.test.tsx src/features/observability/presentation/Observability.test.tsx`: **155/155 pass**, including 10 new regression cases. `npx tsc -b`, targeted ESLint and the production build pass. The existing >500kB chunk warning remains; no runtime-performance improvement is claimed for this styling slice.
  - Rollback boundary: the seven shared component TSX files and their test, `theme.css`, `mission-control.css`, `DemoShell.css`, `TerminalEntry.tsx`, plus this T2 log/status. The slice exceeds the ~400-line review target mainly because old CSS is removed; it remains one cohesive migration, with no unrelated work.
- **L7 (2026-10-26, T3 local delivery):** User approved creative freedom for the design-system presentation. Added an offline, responsive catalog with semantic palette, type specimens, seven live component previews, variant controls, prop examples, searchable source tokens and downloads. `vite.design-system.config.ts` builds the classic-JSX `window.Balancita` IIFE with `@ds-bundle` header, external React and shared-only Tailwind sources. A separate runtime supports the local catalog without CDN dependencies. Fonts are embedded in the CSS, which accounts for most of its ~381 kB size; component JS is ~6.7 kB before gzip.
  - Screen CSS imports moved from the shared `AppShell` to the app entry to keep screen styles out of the library while preserving application load order. No component behavior, app theme values, dependency versions, strategy logic or market integrations changed.
  - Token extraction fails on empty, malformed, duplicate or unresolved declarations; usage metadata must reference real tokens. Exporter tests compare generated JSON to the exact source token list and check the generated catalog embeds it.
  - Validation: `pnpm design-system:build`, `pnpm design-system:test` (3/3), `pnpm design-system:verify` (all seven previews and their variants at 1440/768/390px, token search, offline fonts, zero horizontal document overflow, zero runtime errors or external requests). Classic bundle/header and absence of screen/default-palette CSS checked. `npx tsc -b`, focused ESLint and shared/app-entry tests (25/25) pass.
  - Application regression check: before/after production builds served through the existing localhost port with identical replayed GET responses and initial public WS snapshot. Terminal (389 DOM elements) and Estrategias (191) have identical computed styles and geometry at 1600/760/390px. No server restart or new ports.
  - Review boundary: about 1,200 new source lines, largely the formatted catalog presentation, exceeding the ~400-line target. This is a single runnable local-catalog deliverable; tests and generator stay together. Rollback removes `scripts/design-system/`, `vite.design-system.config.ts`, the package scripts and config include, and restores the two AppShell screen imports/removes the app-entry imports. The app itself remains otherwise unchanged.
  - Open items: external artifact publication and a real React 18 host verification. Neither is claimed complete, and no third-party upload was performed. The user reviews and commits; no co-author trailer is added to the handoff command.
- **L8 (2026-10-26, T4):** Added `src/shared/design-system/guardrails.test.ts`, with no new dependency or runtime JavaScript. Detects bracket-based arbitrary utilities/properties/variants, raw hex colors and `text-ink-3` (including variants, opacity and important modifiers) in static class values. Diagnostics name the declaration file, line and offending value. CSS checks use exact paths, not broad legacy-directory exemptions. The theme explicitly excludes test/spec files from Tailwind's source scan so negative fixtures never generate production utilities.
  - Validation: focused Vitest suite **21/21 pass**, including negative fixtures for every rule, positive semantic/legacy cases, imported nested maps, cyclic aliases, default parameters, CSS additions/renames and real application TSX/CSS scans. Typecheck, targeted ESLint, Prettier and `git diff --check` pass.
  - Tailwind application sources are explicitly limited to `src`, excluding tests/specs. Excluding tests alone was insufficient: documentation also contains forbidden-class examples. The T3 library source override follows the explicit application-source directive, keeping its shared-component-only scope.
  - Runtime harness: **N/A**, no runtime behavior change; production build verifies fixture utilities are absent and application semantic utilities remain present, and T3's generated catalog still passes verification. No servers or ports started. Rollback boundary: delete the guard test, restore the theme/config source directives, and revert this T4 plan/log update. One reviewable work unit, under 400 authored changed lines.
- **L9 (T5a):** Migrated market strip, alerts/diagnosis notices, product select, loading/error wrapper and system usage chip to semantic utilities. Removed **166 legacy CSS lines** (101 Terminal, 62 DemoShell, 3 observability); unused warning/ok/error badge variants were deleted, not recreated. No trading, chart or strategy logic changes.
  - Review first: `TerminalNotices.tsx` and `MarketStrip.tsx`; then the native select cascade in `TerminalEntry.tsx`, usage chip and matching CSS deletions. The chart, account/history tables and decision-panel styles are intentionally still legacy.
  - Validation: **114/114 Vitest tests** across Terminal, shared components and guardrails, including six new market/notice tests. Typecheck, focused ESLint, Prettier and `git diff --check` pass. App production build passes with the existing chunk-size advisory.
  - Runtime harness: production builds intercepted on the existing `localhost:5173`, replaying the same GET responses, public WebSocket snapshot and frozen clock. **56 before/after scenarios**: live, select hover/focus, expanded health/usage inspector, Estrategias, bootstrap error and pending bootstrap, each at 1600/761/760/481/480/461/460/390 px. Geometry and visual styles match; screenshots reviewed. Pill radii normalize to their identical clamped geometry; auto margins use typed computed values plus bounding rectangles rather than Chrome's inconsistent shorthand serialization. API settling is required before capture; otherwise initial loading states produce false differences.
  - Performance: sequential production samples, **20 s each**, both **60.1 FPS / 2.2% browser task CPU / 0 frames >50 ms / 0 long tasks**. Script time 198 ms in both samples; no performance improvement is claimed. Five live bootstrap GETs: **1.221 s first**, then **113/93/91/112 ms**; the cold outlier is recorded, not hidden. Strategy-switch frame gaps remain part of later T5/T6 acceptance, not claimed tested by this slice.
  - Catalog regenerated and verified offline: **48 source tokens**, seven real previews and their variants at 1440/768/390 px, no external requests; all three exporter tests pass.
  - Rollback boundary: remove `TerminalNotices.tsx` and `MarketStrip.test.tsx`; restore T5a edits in `MarketStrip.tsx`, `FuturesTerminal.tsx`, `SystemUsageChip.tsx`, `TerminalEntry.tsx`, both app stylesheets, the badge rule in `observability.css`, theme additions and this plan update. No data, dependencies or service changes. Local-only; no Git writes.
- **Next step:** user reviews/commits T5a; continue with T5b chart migration, then T5c to complete T5. External T3 publication and React 18 host validation remain pending.
