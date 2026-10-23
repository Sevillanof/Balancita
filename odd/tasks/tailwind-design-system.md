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

| Today | `@theme` variable | Utility example |
|---|---|---|
| `--mc-canvas` `#0a0d14` | `--color-canvas` | `bg-canvas` |
| `--mc-surface-1` / `-2` / `-hover` | `--color-surface-1` / `-2` / `-hover` | `bg-surface-1` |
| `--mc-border` / `-strong` / `-focus` | `--color-line` / `-strong` / `-focus` | `border-line` |
| `--mc-long` / `--mc-short` / `--mc-warn` / `--mc-info` | `--color-long` / `short` / `warn` / `info` | `text-long`, `bg-long/10`, `border-long/25` |
| `--mc-text` / `-2` / `-3` | `--color-ink` / `ink-2` / `ink-3` | `text-ink-2` |
| `--mc-on-long` | `--color-on-long` | `text-on-long` |
| `--mc-space-xs…xl` (4–24px) | `--spacing: 4px` | `p-1`=4, `p-2`=8, `p-3`=12, `p-4`=16, `p-6`=24 |
| `--mc-radius` 4px / `-lg` 8px | `--radius-sm` / `--radius-lg` | `rounded-sm` |
| `--mc-font` / `--mc-font-mono` | `--font-sans` / `--font-mono` | `font-mono` |
| 11px label, 12px hint, 13px, 14px body, 16px title, 20px value | `--text-label`, `--text-hint`, `--text-note`, `--text-body`, `--text-title`, `--text-value` (each with `--line-height`) | `text-label` |
| `--mc-shadow-popover` | `--shadow-popover` | `shadow-popover` |

The status pill formula (10% fill, 25% border, full-strength text) becomes `bg-long/10 border-long/25 text-long`: Tailwind v4 builds opacity modifiers with `color-mix`, the same technique the CSS uses today.

`mc-text-3` is about 2.6:1 on the canvas. It keeps its decoration-only rule; the guard in T4 rejects it on text.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1, S3, S5 | inline | pending (needs dependency approval) | — |
| T2 | S1, S2, S5 | inline | pending | — |
| T3 | S4 | inline | pending | — |
| T4 | S2, S3 | inline | pending | — |
| T5 | S1, S2, S5, S6 | inline | pending | — |
| T6 | S1, S2, S5, S6 | inline | pending | — |
| T7 | S1, S2, S5 | inline | pending | — |
| T8 | S1 | inline | pending | — |

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

### T4 — Guard rails

- A Vitest test that scans `src/**/*.tsx` and fails on: arbitrary values in `className` (`-[`), raw hex colors, `ink-3` on text, and any new `.css` file other than `theme.css`. No new lint dependency.
- Check: the test fails on a fixture with each violation, passes on the codebase.

### T5 — Terminal screens

- Migrate `src/app/ConnectedTerminal.css` (404 lines), the rest of `src/app/DemoShell.css` (427) and `src/features/trading-view/presentation/terminal-chart-panel.css` (324). Delete each file when its screen is done.
- Check: screenshots; S6 measurements (bootstrap time, frame gaps).

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

Each task is one work-unit commit and, where it passes ~400 authored lines, its own PR in a chain against `main`. Push and PR creation use the Sevillanof account.

## Log

- **L1 (2026-10-23, user, verbatim):** «Hablemos en espeañol. Pensemos con cual lo podemos hacer, si no es tailwing» · «Tambien el plan es dejar de usar css plano, y empezar a usar otra cosa, pensaba en tailwing? Que decis vos? Se critico» · «Lo que me molesta es que el css que tenemos hoy es feo y no tiene buen performance. Yo quiero algo limpio y que funcione bien.» · «El design system tiene que estar unificado. Tailwind puede ser la mejor opcion para unificarlo y hacerlo escalable?» · «Escribime un archivo .md para implementarlo.»
- **L2 (2026-10-23, evidence):** CSS audit: 11 potentially expensive properties across 13 files, all screen CSS uses only `--mc-*`. The Terminal slowness was the gateway (85% of CPU in two SQLite tails), fixed in 9365be8d; CPU ~65% → ~4%, bootstrap ~0.1 s.
- **L3 (2026-10-23, decision):** Rust migration not recommended (about 158k lines, the Python engine ecosystem, and the ADR freeze on C25-C31 and Kronos). Tailwind v4 accepted as the unification tool, under the rules in S2 and S3.
- **Next step:** approve the two Tailwind dependencies, then T1.
