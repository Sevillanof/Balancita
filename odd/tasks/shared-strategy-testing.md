# Shared strategy testing
## Objective
Make the existing Testear flow truthful and reproducible for all current strategies without introducing new execution capabilities.
## Authorization and scope
User selected the recommended first delivery: shared tests, incomplete funding and temporal separation. Full versioned DSL, new causal features/price plans, new Qwen OPEN gate and shared-capital execution are deferred, not completed by this delivery.
## Constraints
- Read project skill, README and complete immutable ADR through 2026-10-19.
- Preserve frozen behavior, source specs and historical results. Never restore deleted C29/C30 in the owner's checkout.
- Reproduce only the owner's current tracked configuration/deletion overlay in this isolated worktree, recording it as pre-existing baseline, not implementation. Never copy data, secrets or databases.
- Keep config/strategy-gate.json thresholds unchanged, including aggregate 95% funding completeness; do not silently change metrics population or funding denominator.
- Partial observed P&L is distinct from definitive net. Missing costs/funding are not complete zero.
- Historical deterministic evaluation is not full Qwen-policy validation. Unsupported, no-trades, missing evidence and baseline success are distinct states.
- Temporal stability folds are not training/testing walk-forward. Purge boundary-crossing trades and define embargo by existing supported policy, without inventing an arbitrary new duration.
- Existing API and UI remain usable; no new screens or modules.
- One OpenAI writer at a time. Source tasks delegated due to multi-file preparation/write trigger. Independent verification delegated when required.
## Tasks
- [x] T0 — Decouple compatibility tests from deleted production C29/C30 using explicit historical test fixtures; preserve behavior assertions and absent-strategy coverage.
- [x] T1 — Add evaluation-policy classification and gate preflight metadata; first observe baseline checks against current inventory.
- [x] T2 — Preserve partial accounting while exposing definitive-net completeness and aggregate eligibility explicitly.
- [x] T3 — Purge temporal fold boundary overlap using existing supported logic and report censored/excluded evidence.
- [x] T4 — Attach bounded reproducibility provenance and distinguish missing artifacts from auditable validation.
- [x] T5 — Show evaluation scope, reasons and funding completeness in existing Testear UI/API, including old-run fallback.
- [x] T6 — Run focused/broader regression checks and document a safe local manual test procedure.
- [x] E1 — Diagnose unexpected pnpm auto-install activity read-only and establish a safe verification route without dependency changes.
## Acceptance and checks
Each behavior task requires observed RED, GREEN, negative/boundary tests and checks after refactoring. No production backtests/downloads/model calls/services. Python unittest fixtures may use disposable temporary directories/databases; no real data directory access. Disable bytecode generation for focused commands.
Candidate Python runner: PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python:python/tests python3 -m unittest <explicit modules>
Frontend runners must be confirmed against package.json and available dependencies before execution. No installers or lockfile changes.
Preserve legacy tests without production-spec restoration; baseline failures require exact observed evidence before being classified pre-existing.
Verification must reconcile costs once, funding signs/coverage, original aggregate threshold, boundary inclusion, legacy payloads and product-vs-run scope.
## Progress
T0-T6 complete. Historical per-attempt verification logs (Mac worktree, pnpm incident) were dropped when the work was moved to main; the evidence is the tests in python/tests and the vitest tests in src/features/strategy-lab.
Closed: T0 C29/C30 compat fixtures; T1 evaluation policy/preflight; T2 accounting; T3 purged temporal folds; T4 provenance/audit; T5 scope block in Testear; T6 regressions + docs/shared-strategy-testing.md.
Out of scope (deferred): versioned DSL, new causal features/price plans, Qwen OPEN gate replay, shared-capital execution. Gate thresholds unchanged (min_trades adjustment follows ADR amendment 7 in a separate change).
