# Balancita

A local-first personal trading workspace. It renders a realtime watchlist and an
instrument detail view with a candlestick chart. Mock market data remains the
default; Kraken read-only mode is available for BTC-EUR only.

## Requirements

- **Node.js**: `^20.19.0 || >=22.12.0` — the version range required by Vite 8.3.0
  (see its `engines` field). Verified against Node v22.22.2.
- **pnpm**: >= 9 — the project's package manager; the lockfile is `pnpm-lock.yaml`.

## Install

```bash
pnpm install
```

## Development

Start everything (MOCK and real data) with one command:

```bash
pnpm run dev
```

Open <http://localhost:5173>. `pnpm run dev` starts seven processes, each with a
prefixed log:

| Process   | Port | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vite`    | 5173 | Web app and proxy (`/api` -> 8787, `/api-mock` -> 8788, `/api-live` -> 8789, rewritten to `/api`)                                                                                                                                                                                                                                                                                                                                                                                          |
| `server`  | 8787 | Legacy backend (Gemini, spot collectors); `FUTURES_MODE` is forced unset, so `.env` cannot change it                                                                                                                                                                                                                                                                                                                                                                                       |
| `mock`    | 8788 | Scripted MOCK futures API (`futures-local-terminal.mjs --api-only`); fresh temporary database per start                                                                                                                                                                                                                                                                                                                                                                                    |
| `capture` | -    | Kraken public WebSocket -> `server/data/dev-live/futures-market.sqlite` (sole writer; no HTTP, no engine, no account DB; per-event commits)                                                                                                                                                                                                                                                                                                                                                |
| `live`    | 8789 | Read-only gateway: serves `/api/terminal/*` by tailing that market DB by rowid; starts no collector and no engine (engine shown as off)                                                                                                                                                                                                                                                                                                                                                    |
| `verdict` | -    | Python verdict service C: reads the market DB read-only and writes entry verdicts to `server/data/dev-live/futures-verdicts.sqlite` (sole writer; needs Python 3.9+, see below)                                                                                                                                                                                                                                                                                                            |
| `paper`   | -    | Python paper execution D: reads the market and verdicts DBs read-only and writes the paper account (hash-chained events plus snapshots) to `server/data/dev-live/futures-paper-account.sqlite` (sole writer; needs Python 3.9+, see below)                                                                                                                                                                                                                                                 |
| `scores`  | -    | Python forecast scorer E: reads the market and verdicts DBs read-only and scores every LONG/SHORT proposal and the selected decision against the later official candles (returns at 15m/1h/4h/24h gross and net of 12 bp round-trip cost, target/stop race, 30m excursions) into `server/data/dev-live/futures-forecast-scores.sqlite` (sole writer, append-only; needs Python 3.9+; `python -m balancita_engine.futures_forecast_scores --scores-db <db> --report` prints the aggregates) |

`server/.env` is optional: the dev run adds `--env-file-if-exists=.env` only
when the file exists (with `--watch`, Node crashes on a missing watched file).
Create it if you need `GEMINI_API_KEY` or other settings; restart after
creating it. `FUTURES_MODE` was retired: the server refuses to start if it is set
to any non-empty value, so remove it from `.env` (live now runs as the separate
`capture`, `live`, `verdict`, `paper` and `scores` processes above).

Before spawning anything `pnpm run dev` checks ports 5173, 8787, 8788 and 8789.
If one is taken (usually a stale `pnpm run dev` from another checkout) it prints
the port and the child and exits with code 1 without starting anything. Free
the port with `lsof -ti tcp:<port> | xargs kill` (macOS/Linux) and retry. On
macOS/Linux each child runs in its own process group and Ctrl+C or SIGTERM
stops the whole group, so no orphan keeps a port.

### Switching between MOCK and real data

- **Futures terminal** (`/terminal`): choose "MOCK" or "Real (paper, Kraken
  público)" in the "Fuente de datos" switch. The choice is kept in
  `?source=mock|live` and in local storage; the default is MOCK. Switching
  remounts the terminal, so no stream state mixes. If the selected backend is
  unreachable the page says so and names the source; it never falls back to the
  other one. `?source=legacy` opens the previous terminal served by the legacy
  backend.
- **Spot dashboard** (`/`): choose "MOCK" or "Real (Kraken)". The
  `VITE_MARKET_DATA_PROVIDER` variable (`mock` or `kraken`, default `kraken`)
  only sets the initial choice. Switching recreates the provider and resets
  quotes and subscriptions.

### Python requirement

`verdict`, `paper` and `scores` need Python 3.9+ whose `sqlite3` module links SQLite
3.37+ (the market, verdicts and account tables are `STRICT`); the standard
library is enough. `pnpm run dev` looks for it once at startup: first the
executable named in `BALANCITA_PYTHON` (no fallback if that one fails), else
`python3`, `python` and, on Windows, `py -3`. Each candidate must actually run
and meet both versions. Example:
`BALANCITA_PYTHON=/opt/homebrew/bin/python3 pnpm run dev`. The macOS system
Python from the Xcode Command Line Tools is 3.9 and may link an older SQLite;
install Python from python.org or Homebrew in that case.

If none qualifies, `dev` prints one `[dev]` line naming what it tried, does not
start `verdict`, `paper` and `scores`, and the terminal shows "Servicio de veredicto y
ejecución paper no disponibles" with the engine as unavailable
(`python_unavailable`, or `python_sqlite_too_old`). The other processes keep
running.

### Optional LLM decisions (`llm` and `q`)

`pnpm run dev` can also start a local `llama-server` (`llm`) and the Python
decision service Q (`q`), which asks typed questions about each new verdict and
stores the answer probabilities in `server/data/dev-live/futures-llm-decisions.sqlite`
(append-only, single writer). They are optional and never block startup: they
start only when `DECISIONS_ENABLED` is not `0`, the `llama-server` binary is on
`PATH` (`brew install llama.cpp`) and Python is available; otherwise `dev`
prints one `[dev]` line and goes on. Ctrl-C stops `llm` with the rest.

**The model runs fully offline.** `dev` never downloads a model: `llama-server`
is always started with `--offline` and bound to `127.0.0.1`, and the Python
provider refuses any `--llama-url` that is not loopback (`127.0.0.1`,
`localhost`, `[::1]`).

When neither `LLAMA_MODEL_PATH` nor `LLAMA_HF` is set, `dev` looks for an already
downloaded Qwen3.5-4B or Qwen3-4B GGUF (`*qwen3.5-4b*.gguf` or `*qwen3-4b*.gguf`,
any case; `mmproj` files and partial downloads are skipped) in the llama.cpp
cache (`~/Library/Caches/llama.cpp` on macOS, `~/.cache/llama.cpp` on Linux, or
`LLAMA_CACHE`), the Hugging Face hub cache (`models--unsloth--Qwen3.5-4B-GGUF`,
`models--Qwen--Qwen3-4B-GGUF`, `models--unsloth--Qwen3-4B-GGUF`, under
`HF_HOME`/`snapshots/<commit>/`), LM Studio (`~/.lmstudio/models`,
`~/.cache/lm-studio/models`), `~/models` and `~/Downloads`, a few levels deep at
most. Qwen3.5-4B wins over Qwen3-4B when both exist; then Q8_0, then Q6_K, then
any other quant. It prints one line naming the choice, for example
`[dev] llm model: found /Users/you/.cache/huggingface/hub/models--Qwen--Qwen3-4B-GGUF/snapshots/<commit>/Qwen3-4B-Q8_0.gguf (...)`.
If nothing is found, `dev` prints one `[dev]` line saying so and does not start
`llm` or `q`; set `LLAMA_MODEL_PATH` in `.env.local`. `-hf` is used only when you
set `LLAMA_HF` yourself (with `--offline` it can only use the local cache).

To pin the model, create `.env.local` (gitignored) in the repo root:

```bash
LLAMA_MODEL_PATH=/path/to/Qwen3-4B-Q8_0.gguf
```

`dev` loads `<repo>/.env.local` and then `<repo>/.env` for its children; real
environment variables win over `.env.local`, which wins over `.env`. The
variables:

| Variable             | Default     | Meaning                                    |
| -------------------- | ----------- | ------------------------------------------ |
| `DECISIONS_ENABLED`  | on          | `0` disables `llm` and `q`                 |
| `LLAMA_MODEL_PATH`   | -           | local `.gguf` (`-m`); wins over `LLAMA_HF` |
| `LLAMA_HF`           | -           | explicit Hugging Face ref (`-hf`, offline) |
| `LLAMA_PORT`         | `8088`      | loopback port (also checked for conflicts) |
| `LLAMA_CTX`          | `8192`      | context (`-c`)                             |
| `LLAMA_PARALLEL`     | `2`         | parallel slots (`-np`)                     |
| `DECISIONS_PRODUCTS` | `PF_XBTUSD` | products Q decides, comma separated        |

**First thing to run** (with `llama-server` up, by hand or via `pnpm run dev`):

```bash
PYTHONPATH=python python3 -m balancita_engine.futures_llm_decisions --probe
```

It sends one `direction_1h` request through each of the two probability
sources and prints them side by side: the raw `top_logprobs` (with the exact
token strings, `"A"` or `" A"`), the `top_probs` after the grammar, whether
thinking leaked (`<think>`), the token count of each letter via `/tokenize`, the
latency of each source, and a table of letters present, probabilities and
latency, followed by `service would use: ...` and a `RESULT:` line. Exit code
`0` means usable, `1` means a problem (do not continue; if thinking leaked, start
`llama-server` with `--reasoning off`), `2` means the model is not healthy.
`--probe-prompt-variants` sends the same state with every prompt version in
`config/decision-prompts.json` (1 = the old prompt, 2 = the default, 3 = v2 plus
an assistant prefill `Answer: `) through both sources, to compare them on your
machine. `--probability-source` and `--prompt-version` override the config.
`--ask <question_id> [--product PF_X] --market-db ... --verdicts-db ...` asks one
catalog question about the latest stored state and prints the probabilities,
chosen option, confidence and latency without storing anything.

**Why two probability sources.** llama-server computes `logprobs` before the
grammar, so a model whose natural first token is `To` or `Based` can push `A`,
`B` and `C` out of the top 20. Two layers fix that, both data-driven in
`config/decision-prompts.json`:

1. A versioned prompt (`default_version`, now 2): a system message ("You are a
   classifier. Reply with exactly one option letter and nothing else.") and a
   final line `Answer with one letter (A, B or C):`, so the letter is the
   natural first token. STATE stays first and QUESTION and the options keep the
   `A) ... B) ...` format. The prompt version is stored with every decision and
   hashed into `prompt_hash`; changing any text of a version needs a new version.
2. `probability_source`: `raw_logprobs`, `post_sampling` or `auto` (default).
   `post_sampling` sends `post_sampling_probs: true` with temperature 1, `top_k`
   0, `top_p` 1 and `min_p` 0, so the grammar leaves only the option letters and
   the returned `prob` values are the model's distribution over them. The decision
   is the argmax of those probabilities, never the sampled token, and the
   calibration temperature is applied on top in both sources. `auto` asks raw
   first and re-asks with `post_sampling` when any option letter is missing. The
   source used is stored per decision (`probability_source`).

Questions are data in `config/decision-questions.json` (prompts in `config/decision-prompts.json`): id, version, type
(`choice`, `bool` asked as `A) true B) false`, or `score` with a numeric value
per option), instruction, options with descriptions and the STATE fields the
question needs (named, normalized fields from one registry in
`futures_llm_decisions.py`). Add a question by editing that file; changing the
text of an existing one requires bumping its `version` (a test pins a hash per
`id@version`). Calibration temperatures live in `config/decision-calibration.json`
(default T=1).

Behavior: one decision per question for each new verdict bucket whose lag is at
most 15 s (the backfill is skipped) and that was written recently. If the model is
down, loading or times out, nothing is stored for that bucket (one log line per
state change) and it is never retried. Downstream code reads stored decisions
only; `--once` never asks again for a stored bucket. STATE carries normalized
values only (returns in bp, distances in ATR units, RSI, band positions, regime,
strategy actions) and no dates, absolute prices or product name. Note the
residual risk: a model can still recognize a market episode from its numeric
shape, so decisions on past data are not proof of skill; judge them only on
data after the model's training cutoff and against the stored calibration.

### News process (`news`)

`pnpm run dev` starts the Python news process N (`news`) whenever Python is
available (`NEWS_ENABLED=0` turns it off). It polls the public RSS/Atom feeds in
`config/news-sources.json` (every 5 minutes per feed, with a timeout, a 2 MB cap
and backoff after failures; add feeds with `NEWS_EXTRA_RSS_FEEDS`, the same
`id|label|https url|license` format as the legacy news feature) and is the single
writer of `server/data/dev-live/futures-news.sqlite` (append-only). Each item is
stored with its source, URL, sanitized title and summary, published time,
`received_at` and a dedupe hash. The legacy Gemini news polling in the `server`
child is untouched and still off unless you enable it; N never calls Gemini.

Ingest never needs the model. When the `llm` child is enabled (same
`DECISIONS_ENABLED` and local-model rules as above) `news` is started with
`--analyze` and asks the local Qwen, through Q's own provider (loopback only,
grammar plus logprobs), the two `news` questions of `config/decision-questions.json`
about each new item: `news_relevance_btc` (none, low, medium, high) and
`news_direction` (bullish, bearish, neutral). The probabilities, chosen option,
confidence, prompt and question versions and model identity are stored per
`(item, question, version)`. News is never sent to a remote API. If the model is down the
items stay pending and are retried only while they were received within the last 30
minutes; older ones get an explicit `skipped_stale` row and are never asked, so there
is no catch-up storm.

```bash
# one polling round without the model (works anywhere with internet access)
cd server && PYTHONPATH=../python python3 -m balancita_engine.futures_news \
  --once --news-db ./data/dev-live/futures-news.sqlite
# what the verdict service will be able to read at a decision time (epoch ms)
PYTHONPATH=../python python3 -m balancita_engine.futures_news \
  --news-db ./data/dev-live/futures-news.sqlite --features-at $(date +%s)000
```

`news_features(db, t)` returns, for the last 1 h and 4 h, `items`, `count_relevant`,
`relevance_mass`, `weighted_sentiment` and `max_relevance` using only rows received
and analyzed at or before `t` (no lookahead). Process C does not read them yet.

### Offline behavior

Without network access the `capture` process (and the Real source) cannot reach
Kraken and report it; `vite`, `server` and `mock` keep running, so MOCK stays
usable. A failed `mock`, `capture`, `live`, `verdict`, `paper` or `scores` process is logged and does not stop
the others. If `capture` stops, the `live` gateway keeps serving stored candles
and reports the feed as stale; restarting `live` does not affect `capture`.
Press Ctrl-C once to stop every process.

### Market data mode

Kraken mode uses public, unauthenticated REST and WebSocket market-data
endpoints and exposes only BTC-EUR. TTWO and SPCX remain mock-only. This mode is
for local/internal personal use only, and Kraken market data is not redistributed
to third parties. Kraken's terms of use were last reviewed on 2026-09-21. Paper
trading always uses the deterministic mock feed and its existing local simulator
authority; Kraken prices are never used to execute or simulate orders.

### Local MOCK futures terminal: start, interrupt, recover

A reproducible, fully simulated BTC/USD perpetual scenario (no network market
data, no real orders, no credentials, funding fixed at zero). It needs Node
`>=22.12` (verified on v22.22.2) and `python3` on `PATH` (standard library only).
The UI is always labeled MOCK; nothing falls back silently to another mode.

Start (fresh run; the output directory must not exist):

```bash
node scripts/futures-local-terminal.mjs --api-port 8787 --ui-port 5174 \
  --output-dir /tmp/balancita-demo --interrupt-after-stage partial-fill
```

Open <http://127.0.0.1:5174/terminal>. The scenario starts when the page
subscribes. After `partial-fill` commits (stage 3 of 5; long 0.005 BTC open) the
status line reads "Escenario interrumpido ... (MOCK)", the process prints
`INTERRUPTED ...` plus a one-line `--resume` hint, and exits with code `75`
(check with `echo $?`). The UI server stops with it, so the open page cannot be
reloaded until `--resume` starts it again. All state stays in
`/tmp/balancita-demo/paper-futures.sqlite`. `--interrupt-after-stage` takes a
stage name (`warmup`, `entry-selection`, `partial-fill`,
`protective-stop-crossing`) or `1`-`4`. Without it the run just completes
(flat, equity `9999.21014`, fees `0.49986`, gross `-0.29`, two fills).

Recover (same ports and directory; reload the page):

```bash
node scripts/futures-local-terminal.mjs --api-port 8787 --ui-port 5174 \
  --output-dir /tmp/balancita-demo --resume
```

`--resume` only accepts a directory created by this launcher for this exact
scenario (`local-terminal-output.json` plus a verified SQLite run) and refuses a
missing, foreign, mismatched or corrupted one. It re-verifies the run, continues
at the first stage without a committed receipt (a stage that was accepted but
not committed is re-driven by its own work id, so there are no duplicate orders
or fills), restores any candles that were committed but not yet presented, and
shows "Escenario reanudado desde SQLite (MOCK) ...". A killed process (Ctrl-C,
`kill -9`) is recovered the same way.

Verify against a continuous run: the automated check is
`pnpm --dir server exec vitest run src/features/paper-futures/futures-local-scenario.test.ts`,
which compares the recovered run with a continuous one (orders, fills, fees,
position, P&L, analyses, durable events and head hash), including a `SIGKILL`
at a committed boundary and with a stage accepted but not committed. Manually,
the final account must equal the continuous values above.

Limits: single scripted scenario; funding is zero, so this does not verify
funding accrual; recovery is of the scripted MOCK run, not of any real feed;
pause/resume/new-run commands issued after a recovery replay a rebuilt copy
of the last scripted market; that path is not verified here.

## Scripts

| Command             | Description                             |
| ------------------- | --------------------------------------- |
| `pnpm dev`          | Start the Vite dev server with HMR      |
| `pnpm test`         | Run the test suite once (Vitest)        |
| `pnpm test:watch`   | Run tests in watch mode                 |
| `pnpm typecheck`    | Type-check the whole project (`tsc -b`) |
| `pnpm lint`         | Lint with ESLint                        |
| `pnpm format`       | Format all sources with Prettier        |
| `pnpm format:check` | Check formatting without writing        |
| `pnpm build`        | Build the production bundle             |
| `pnpm preview`      | Serve the production build locally      |

## Tests

Tests run on jsdom with Testing Library and user-event. Test files live next to the
code they verify (e.g. `src/App.test.tsx`).

## Product scope (Phases 4 and 9)

The default watchlist shows deterministic mock instruments with realtime mock
quotes, and selecting an instrument opens a detail view with its price summary
and a mock candlestick chart. In Kraken mode the catalog is filtered to the
public BTC-EUR pair and the same UI consumes read-only live/history data. A
workspace tab list switches between Watchlist and Portfolio. The portfolio keeps
manual positions (quantity and average cost) in localStorage behind a versioned
`PortfolioRepository`, subscribes to the selected market source for eligible
holdings and derives per-position cost, current value and profit/loss (absolute
and percentage) on render; quotes and totals are never persisted. Corrupt stored
data surfaces an explicit reset instead of being silently trusted. The screen
identifies the product ("Balancita") and never requests credentials. There is no
backend, no authentication and no global state.
The roadmap lives in `doc/personal-trading-app.md`, which is the single source of
truth and must not be edited by tooling.

## Chart attribution

The candlestick chart is rendered with [Lightweight Charts] by TradingView, which is
licensed under the Apache License 2.0 and requires attribution. The chart shows the
TradingView attribution logo in the corner by default
(`layout.attributionLogo`).

[Lightweight Charts]: https://www.tradingview.com/lightweight-charts/
