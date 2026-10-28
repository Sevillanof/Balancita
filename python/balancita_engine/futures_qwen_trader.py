"""Qwen operador: Qwen decides by itself when to enter and when to exit (paper; PF_XBTUSD and PF_ETHUSD).

One engine, two uses (live == replay): ``Trader`` is fed CLOSED 5m candles one by one and returns what happened. It reads
nothing else, so it cannot look ahead: the historical practice below and the (later) live process run this same class.

What Qwen decides (``config/qwen-trader.json``, ``prompt.version`` 1)
    * Flat: LARGO / CORTO / ESPERAR. In a position: MANTENER / CERRAR. One grammar-constrained letter, probabilities read
      from the logprobs (``futures_llm_decisions.ask_model``), asked in two option orders and averaged (position-bias
      control). Only when the action is LARGO / CORTO / CERRAR a second 1-token call asks the reason (fixed list).
    * An entry needs p(action) >= the entry threshold. The practice enters with the lowest threshold of the predeclared
      grid and records p; the report picks the threshold on the calibration fold and judges on the validation fold.

Wake rules (deterministic, closed candles only; Qwen is asked ONLY when one fires, which keeps calls cheap)
    flat: every closed 1h candle; a strong move (|log return| of 15 or 30 min above 2 x its normal size, normal = the
    5m log-volatility of the last 288 bars scaled); a funding publication that is extreme or jumps.
    in position: every 15 min; the same strong move; adverse move above 75 % of the stop distance; funding as above.
    Extra wakes (strong move, near stop) are at least 10 min apart (so they can fall between two 15 min boundaries). ``WAKE_HOOKS`` is the extension point for later
    signals (strategies, news): empty and a no-op today.

Guardrails (Qwen cannot override them)
    hard stop at ``stop_sigma_24h`` x the 24 h sigma measured when the position opens (1.5 by default, limited to
    ``[min_stop_pct, max_stop_pct]``), forced close after 24 h, 15 min cooldown after any close, 100 USD per trade, one
    position per product. There is NO limit on trades per day (owner's decision).

State shown to Qwen: multi-timeframe numbers (1h / 4h / 24h / 7d returns, volatility, trend, distance to highs and lows,
volume, funding when known), the round-trip cost and, in a position, its own side, open time, unrealized result, distance
to the stop and to the time limit. Never its past performance, never a date, an absolute price or a product name.

Commands (``python -m balancita_engine.futures_qwen_trader <command> --help``)
    prefetch   download and cache Kraken's public 5m candles and funding (the only network use besides loopback)
    practice   random contiguous blocks of history, replayed end to end; resumable; ``--max-minutes``
    report     Spanish markdown (``futures_qwen_trader_report``); no model
    export     one JSON line per decision with state, answer and realized outcome (learning data)

The holdout (``holdout_from`` of ``config/strategy-gate.json``) is NEVER read: the history layer raises ``HoldoutError``
for any request that reaches it. The model only runs on loopback (``llm.check_loopback_url``).
"""

import argparse
import array
import bisect
import calendar
import collections
import contextlib
import hashlib
import json
import math
import os
import random
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

from . import futures_llm_decisions as llm
from .futures_costs import COST_MODEL_VERSION, entry_fill, exit_fill, fee_rate, round_trip_cost_bps, side_impact_bps
from .futures_history import DAY_MS, HOUR_MS, MINUTE_MS, CandleCache, HistoryError, fetch_funding, fill_gaps
from .futures_simulator import accrue_funding

D = Decimal
SCHEMA = "balancita-qwen-trader.v1"
STATE_VERSION = "qwen-trader-state.v1"
DATASET_SCHEMA = "balancita-qwen-trader-dataset.v1"
ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
CONFIG_PATH = os.path.join(ROOT, "config", "qwen-trader.json")
CONFIG_PATH_V2 = os.path.join(ROOT, "config", "qwen-trader-v2.json")
CONFIG_PATH_V21 = os.path.join(ROOT, "config", "qwen-trader-v2.1.json")
CONFIG_PATH_V3 = os.path.join(ROOT, "config", "qwen-trader-v3.json")
CONFIG_PATH_LIVE = os.path.join(ROOT, "config", "qwen-live.json")
CONFIG_PATH_LIVE_V7 = os.path.join(ROOT, "config", "qwen-live-v7.json")   # frozen version 7 (8-factor sheet + LoRA): exam / LoRA tooling
GATE_CONFIG_PATH = os.path.join(ROOT, "config", "strategy-gate.json")
DATA_DIR = os.path.join(ROOT, "data", "qwen-trader")
DEFAULT_DB = os.path.join(DATA_DIR, "practice.sqlite")
DEFAULT_DB_V2 = os.path.join(DATA_DIR, "practice-v2.sqlite")
DEFAULT_DB_V21 = os.path.join(DATA_DIR, "practice-v2.1.sqlite")
DEFAULT_DB_V3 = os.path.join(DATA_DIR, "practice-v3.sqlite")
DEFAULT_EXAM_DB_V3 = os.path.join(DATA_DIR, "exam-v3.sqlite")
DEFAULT_EXAM_DB_LIVE = os.path.join(DATA_DIR, "exam-live.sqlite")     # the Examen of the live config (``exam --version live``)
DEFAULT_DB_LIVE_PRACTICE = os.path.join(DATA_DIR, "practice-live.sqlite")
PRACTICE_VERSIONS = ("1", "2", "2.1", "3")      # the ones that have a report
VERSIONS = PRACTICE_VERSIONS + ("live",)        # "live": the rules of the live operator (``futures_qwen_live``)
DEFAULT_CACHE = os.path.join(DATA_DIR, "cache")
DEFAULT_URL = "http://127.0.0.1:{}".format(llm.DEFAULT_LLAMA_PORT)

BAR_MS = 5 * MINUTE_MS
H1, H4, H24, D7 = 12, 48, 288, 2016           # bars
MIN_BARS = D7 + 1                              # closed 5m candles needed before Qwen is ever asked
MAX_KEEP = 2 * D7 + 600
FLAT_ACTIONS = ("LARGO", "CORTO", "ESPERAR")
POSITION_ACTIONS = ("MANTENER", "CERRAR")
SAFE_FIRST = ("ESPERAR", "MANTENER")           # ties go to the inactive option
CLOSED_BY = ("qwen", "stop", "tiempo", "fin_de_bloque")

WAKE_HOOKS = {}   # name -> callable(trader, t_ms) -> list of wake reasons. Extension point (strategy signals, news): empty today.


class TraderError(Exception):
    """A clear, user-facing failure; the CLI prints it and exits 2."""


class HoldoutError(TraderError):
    """Something asked for data at or after ``holdout_from``. Never allowed."""


class BudgetExhausted(Exception):
    """The ``--max-minutes`` budget ended before the next model call."""


class ModelDown(Exception):
    """llama-server did not answer three times in a row."""


class DecisionError(Exception):
    """The model answered something unusable; the decision counts as 'no answer' (flat / hold)."""


class WakeSkipped(Exception):
    """A decider could not take this wake at all (live: model down or too slow, wake too old). ``Trader.feed`` turns it into a
    ``skipped`` event: nothing was decided, nothing is opened or closed, and the wake is not asked again. The practice never
    raises it."""

    def __init__(self, kind, detail=""):
        super().__init__("{}: {}".format(kind, detail) if detail else kind)
        self.kind, self.detail = kind, detail


# --------------------------------------------------------------------------- config and identity


def version_paths(version):
    """``(config path, practice database)`` of a trader version. v1 stays exactly where it was; v2, v2.1 and v3 have their
    own files. ``live`` is the config of the live operator; its database here is only the one a historical replay with the
    live rules would use (the live process has its own, see ``futures_qwen_live``)."""
    version = str(version)
    if version == "1":
        return CONFIG_PATH, DEFAULT_DB
    if version == "2":
        return CONFIG_PATH_V2, DEFAULT_DB_V2
    if version == "2.1":
        return CONFIG_PATH_V21, DEFAULT_DB_V21
    if version == "3":
        return CONFIG_PATH_V3, DEFAULT_DB_V3
    if version == "live":
        return CONFIG_PATH_LIVE, DEFAULT_DB_LIVE_PRACTICE
    raise TraderError("versión desconocida: {!r} (1, 2, 2.1, 3 o live)".format(version))


def load_config(path=None):
    with open(path or CONFIG_PATH, encoding="utf-8") as handle:
        cfg = json.load(handle)
    if cfg.get("schema") != SCHEMA:
        raise TraderError("config/qwen-trader.json: esquema desconocido {!r}".format(cfg.get("schema")))
    for name in cfg["wake"].get("hooks", []):
        if name not in WAKE_HOOKS:
            raise TraderError("gancho de despertar desconocido: {!r}".format(name))
    return cfg


def config_hash(cfg):
    """Identity of everything that shapes a decision. ``entry_threshold`` is an OUTPUT of the report, not an input."""
    # ``runtime`` (concurrency, skipping the entry reason) only changes speed / what is stored, never an action: not identity.
    # ``exam`` and ``exam_lean`` (v3) only shape the ``exam`` command, which has its own identity (``futures_qwen_trader_exam``)
    # ``live`` (live operator) is how the process polls and budgets time, never what a decision is
    # ``positioning_db`` is where the collector's file lives on this machine, not what Qwen is asked
    body = {k: v for k, v in cfg.items() if k not in ("entry_threshold", "note", "rules", "runtime", "exam", "exam_lean", "live",
                                                          "positioning_db")}
    body["practice"] = {k: v for k, v in cfg["practice"].items() if k != "target_blocks"}   # how many blocks is not identity
    raw = json.dumps({"config": body, "state": STATE_VERSION, "costs": COST_MODEL_VERSION}, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def load_holdout_ms(path=None):
    with open(path or GATE_CONFIG_PATH, encoding="utf-8") as handle:
        return date_ms(json.load(handle)["holdout_from"])


def date_ms(text):
    return calendar.timegm(time.strptime(text, "%Y-%m-%d")) * 1000


def stamp(ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))


def template_of(cfg):
    prompt = cfg["prompt"]
    out = {"version": prompt["version"], "system": prompt["system"], "answer_line": prompt["answer_line"],
           "prefill": prompt["prefill"]}
    if prompt.get("state_last"):
        out["state_last"] = True          # v2.1: fixed text first, the variable STATE last (llama-server prefix cache)
    if lora_of(cfg):
        out["lora"] = lora_of(cfg)        # the LoRA adapter(s) this run asks llama-server to apply (``exam --lora``)
    return out


def lora_of(cfg):
    """``[{id, scale}]`` that every request of this config asks llama-server to apply, or ``None``: ``runtime.lora`` (``exam
    --lora``, not identity: the exam adds it to its own identity, ``futures_qwen_trader_exam.exam_identity``) wins over
    ``cfg["lora"]["request"]`` (the live config from version 7: the adapter IS the identity, ``config_hash`` covers the key)."""
    return (cfg.get("runtime") or {}).get("lora") or (cfg.get("lora") or {}).get("request") or None


def parse_lora(text):
    """``--lora ID[:SCALE]`` -> ``[{"id": ID, "scale": SCALE}]`` (scale 1.0 by default)."""
    head, _, tail = text.partition(":")
    try:
        return [{"id": int(head), "scale": float(tail) if tail else 1.0}]
    except ValueError:
        raise TraderError("--lora espera ID o ID:ESCALA (por ejemplo 0 o 0:1.0), no {!r}".format(text))


def build_prompt(state_text, question, template):
    """The user message. Default layout (v1, v2): STATE, QUESTION, options, answer line (``llm.build_prompt``). With
    ``state_last`` (v2.1) the fixed part comes first and the STATE last, so everything before ``STATE:`` is the same text
    on every wake of the same question and option order and llama-server serves it from its prompt cache."""
    if not template.get("state_last"):
        return llm.build_prompt(state_text, question, template)
    lines = ["QUESTION: " + llm.sanitize_text(question["instruction"])]
    for letter, (option_id, description, _) in zip(llm.LETTERS, llm.question_options(question)):
        lines.append("{}) {}".format(letter, option_id) + ("" if description is None else " - " + llm.sanitize_text(description)))
    if template.get("answer_line"):
        lines.append(template["answer_line"].format(letters=llm._letters_phrase(llm.question_letters(question))))
    lines.append("STATE: " + llm.sanitize_text(state_text))
    return "\n".join(lines)


def runtime_of(cfg):
    """Speed options of a config (``runtime``): ``concurrent_orders``, ``skip_entry_reason``. Absent (v1): both off."""
    runtime = cfg.get("runtime") or {}
    return {"concurrent_orders": bool(runtime.get("concurrent_orders")),
            "skip_entry_reason": bool(runtime.get("skip_entry_reason"))}


def es(value, places=2, sign=False):
    """Decimal-comma number for the prompt (``-0,52``); never ``-0,00``."""
    text = "{:{s}.{p}f}".format(value, p=places, s="+" if sign else "")
    if not text.lstrip("+-").replace(".", "").strip("0"):
        text = text.lstrip("+-")
    return text.replace(".", ",")


def _hm(minutes):
    minutes = max(0, int(round(minutes)))
    return "{} h {:02d} min".format(minutes // 60, minutes % 60) if minutes >= 60 else "{} min".format(minutes)


def _std(values):
    n = len(values)
    if n == 0:
        return 0.0
    mean = math.fsum(values) / n
    return math.sqrt(math.fsum((v - mean) ** 2 for v in values) / n)


# --------------------------------------------------------------------------- funding


class FundingLine:
    """Hourly funding as Kraken publishes it: ``[(period_start_ms, relative_rate_per_hour)]``.

    A period is KNOWN once it ended (``start + 1h``): nothing later is ever read for a decision at ``t``.
    """

    def __init__(self, periods=()):
        self.periods = sorted((int(s), float(r)) for s, r in periods)
        self.starts = [p[0] for p in self.periods]

    def __len__(self):
        return len(self.periods)

    def known_count(self, t_ms):
        return bisect.bisect_right(self.starts, t_ms - HOUR_MS)

    def latest(self, t_ms):
        index = self.known_count(t_ms)
        return self.periods[index - 1] if index else None

    def published(self, prev_t_ms, t_ms):
        """``(previous_rate_or_None, new_rate)`` when a period became known in ``(prev_t_ms, t_ms]``, else ``None``."""
        top, low = self.known_count(t_ms), self.known_count(prev_t_ms)
        if top <= low:
            return None
        return (self.periods[top - 2][1] if top >= 2 else None), self.periods[top - 1][1]

    def percentile(self, t_ms, window=720):
        """Percentile (0-100) of the newest known rate against the ``window`` before it; ``None`` below 90 % coverage."""
        top = self.known_count(t_ms)
        if top < 2:
            return None
        newest = self.periods[top - 1]
        low = bisect.bisect_left(self.starts, newest[0] - window * HOUR_MS)
        rates = [p[1] for p in self.periods[low:top - 1]]
        if len(rates) < int(window * 0.9):
            return None
        below = sum(1 for r in rates if r < newest[1])
        equal = sum(1 for r in rates if r == newest[1])
        return 100.0 * (below + 0.5 * equal) / len(rates)

    def accrue(self, start_ms, end_ms, notional, long):
        """``(funding paid by the position in USD (negative: received), milliseconds of the holding time covered)``."""
        low = max(0, bisect.bisect_right(self.starts, start_ms - HOUR_MS) - 1)
        high = bisect.bisect_left(self.starts, end_ms)
        total, covered = accrue_funding([(s, s + HOUR_MS, r) for s, r in self.periods[low:high]], start_ms, end_ms,
                                        notional)
        return (total if long else -total), covered


# --------------------------------------------------------------------------- positions and accounting


class Position:
    __slots__ = ("side", "entry_ms", "entry_ref", "entry_px", "qty", "stop_px", "stop_pct", "max_hold_ms", "entry_p",
                 "entry_reason", "trade_no", "mfe_bp", "mae_bp")

    def __init__(self, **kwargs):
        for name in self.__slots__:
            setattr(self, name, kwargs.get(name))

    def snapshot(self):
        return {"side": self.side, "entry_ms": self.entry_ms, "entry_px": str(self.entry_px), "qty": str(self.qty),
                "stop_px": self.stop_px, "trade_no": self.trade_no}


def settle(product, position, ref_price, reason, end_ms, funding, notional=D(100)):
    """What closing ``position`` at ``ref_price`` (before the exit cost) nets: ``futures_costs`` fills, taker fees on both
    legs and the funding of the holding time. Same accounting as ``futures_simulator.Book._settle``."""
    long = position.side == "LONG"
    px = exit_fill(D(repr(float(ref_price))), position.side, product, reason)
    gross = (px - position.entry_px) * position.qty if long else (position.entry_px - px) * position.qty
    fees = (position.entry_px + px) * position.qty * fee_rate("taker")
    paid, covered = funding.accrue(position.entry_ms, end_ms, position.entry_px * position.qty, long) \
        if funding is not None else (D(0), 0)
    held = max(0, end_ms - position.entry_ms)
    status = "complete" if held and covered >= held else ("partial" if covered > 0 else "unknown")
    net = gross - fees - paid
    return {"exit_px": px, "net_bp": float(net / notional * 10_000), "gross_bp": float(gross / notional * 10_000),
            "funding_bp": float(paid / notional * 10_000), "funding_status": status,
            # the same figures in exact USD (Decimal), for the live books
            "net_usd": net, "gross_usd": gross, "fees_usd": fees, "funding_usd": paid}


# --------------------------------------------------------------------------- questions and the decider


def questions_for(cfg, product):
    """The three questions with the product's real round-trip cost written into the instruction."""
    cost = es(float(round_trip_cost_bps(product)) / 100.0, 2)
    exit_cost = es(float(fee_rate("taker") * 10_000 + side_impact_bps(product)) / 100.0, 2)
    out = {}
    for name, question in cfg["prompt"]["questions"].items():
        out[name] = dict(question, instruction=question["instruction"].replace("{cost}", cost)
                         .replace("{exit_cost}", exit_cost))
    return out


def _merge(question, answers):
    """Mean probability per option over the option orders; ties go to the inactive option."""
    ids = [o["id"] for o in question["options"]]
    probs = {i: math.fsum(a["probabilities"][i] for a in answers) / len(answers) for i in ids}
    entropy = -sum(p * math.log(p) for p in probs.values() if p > 0)
    confidence = min(1.0, max(0.0, 1.0 - entropy / math.log(len(ids))))
    best = max(probs.values())
    tied = [i for i in ids if abs(probs[i] - best) <= 1e-12]
    chosen = next((i for i in SAFE_FIRST if i in tied), tied[0])
    return {"probabilities": probs, "chosen": chosen, "confidence": confidence}


def mirror_passes(action, mirror_action):
    """The mirror test: LARGO on the real numbers needs CORTO on the mirrored ones, and the other way round."""
    return (action, mirror_action) in (("LARGO", "CORTO"), ("CORTO", "LARGO"))


class LlmDecider:
    """Asks the local model. ``store`` (optional) caches every call by ``(key, t_ms, step, variant)``: a replay of a block
    that was cut by the time budget costs no new call. ``deadline_s`` is a time budget in ``clock`` seconds.

    ``concurrency`` > 1 sends the option orders of one question at the same time (llama-server ``-np 2`` serves them in
    parallel). Only the HTTP calls run in threads; results are handled, stored and merged in the fixed variant order by the
    calling thread, so what is stored and decided is the same as asking them one after the other (up to the tiny logit
    differences llama.cpp batching can introduce; see ``check_determinism``)."""

    def __init__(self, provider, cfg, *, store=None, clock=time.monotonic, deadline=None, model=None, concurrency=None):
        self.provider, self.cfg, self.store, self.clock = provider, cfg, store, clock
        self.template = template_of(cfg)
        self.deadline = deadline
        self.model = model
        self.concurrency = (2 if runtime_of(cfg)["concurrent_orders"] else 1) if concurrency is None else int(concurrency)
        self.calls = 0
        self.spent = 0.0              # wall seconds spent waiting for the model (a concurrent pair counts once)
        self.latency_sum = 0.0        # sum of the individual call latencies (what each call took)
        self.down = 0
        self.progress = None          # optional callable(decider), called every ``progress_every`` model calls
        self.progress_every = 200
        self._next_progress = self.progress_every
        self.progress_every_s = None  # optional: also call ``progress`` when this many clock seconds passed without a report
        self._last_progress = None

    def mean_call(self):
        """Wall seconds per call: with concurrent orders this is about half the latency of one call."""
        return self.spent / self.calls if self.calls else 0.0

    def mean_latency(self):
        return self.latency_sum / self.calls if self.calls else 0.0

    def _guard(self, count=1):
        if self.deadline is not None and self.clock() + self.mean_call() * count > self.deadline:
            raise BudgetExhausted()

    def _orders(self, question, single=False):
        count = len(question["options"])
        return [list(range(count))] if single else self.cfg["prompt"]["orders"][str(count)]

    def ask(self, key, t_ms, step, question, state_text, *, single=False):
        """Answer to ``question`` for this STATE: ``{orders, probabilities, chosen, confidence, latency_ms, state_hash}``.

        ``single``: the written order only (the reason call). Raises ``DecisionError`` on an unusable answer."""
        orders = self._orders(question, single)
        cached = self.store.calls(key, t_ms, step) if self.store else {}
        missing = [v for v in range(len(orders)) if v not in cached]
        rows = dict(cached)
        if self.concurrency > 1 and len(missing) > 1:
            rows.update(self._call_many(key, t_ms, step, missing, orders, question, state_text))
        else:
            for variant in missing:
                rows[variant] = self._call(key, t_ms, step, variant, orders[variant], question, state_text)
        rows = [rows[v] for v in range(len(orders))]
        merged = _merge(question, rows)
        return dict(merged, orders=[{k: r[k] for k in ("order", "probabilities", "confidence", "source", "latency_ms",
                                                         "prompt_hash")} for r in rows],
                    latency_ms=sum(r["latency_ms"] for r in rows), state_hash=llm.text_hash(state_text)[:16])

    def _prompt(self, order, question, state_text):
        asked = llm.permuted(question, order)
        return asked, build_prompt(state_text, asked, self.template)

    def _one_request(self, text, asked):
        """The HTTP part only (runs in a worker thread): no shared state is touched."""
        t0 = time.monotonic()
        try:
            answer = llm.ask_model(self.provider, text, llm.question_letters(asked), asked,
                                   float(self.cfg["prompt"]["temperature"]), self.template,
                                   self.cfg["prompt"]["probability_source"])
            return answer, time.monotonic() - t0, None
        except (llm.ModelUnavailable, llm.ModelResponseError) as error:
            return None, time.monotonic() - t0, error

    def _row(self, key, t_ms, step, variant, asked, text, answer, took, state_text):
        result = answer["result"]
        return {"key": key, "t_ms": t_ms, "step": step, "variant": variant,
                "order": [o["id"] for o in asked["options"]], "probabilities": result["probabilities"],
                "chosen": result["chosen"], "confidence": result["confidence"], "source": answer["source"],
                "latency_ms": int(took * 1000), "prompt_hash": llm.prompt_hash(text, self.template),
                "prompt_version": self.template["version"], "state_hash": llm.text_hash(state_text)[:16],
                "model": self.model, "asked_at_ms": int(time.time() * 1000)}

    def _call_many(self, key, t_ms, step, variants, orders, question, state_text):
        """Several option orders of one question at once. Results are consumed in variant order; the first failure stops
        the question exactly as the sequential path would (later variants are neither stored nor used)."""
        self._guard(len(variants))
        prepared = [(v,) + self._prompt(orders[v], question, state_text) for v in variants]
        t0 = self.clock()
        with ThreadPoolExecutor(max_workers=min(self.concurrency, len(prepared))) as pool:
            futures = [pool.submit(self._one_request, text, asked) for _, asked, text in prepared]
            results = [f.result() for f in futures]
        wall = self.clock() - t0
        out, counted = {}, 0
        for (variant, asked, text), (answer, took, error) in zip(prepared, results):
            if error is not None and isinstance(error, llm.ModelUnavailable):
                self.down += 1
                if self.down >= 3:
                    raise ModelDown() from None
                out[variant] = self._call(key, t_ms, step, variant, orders[variant], question, state_text)
                continue
            if error is not None:
                if self.store:
                    self.store.error(key, t_ms, step, variant, error.kind, str(error))
                raise DecisionError(str(error)) from error
            self.down = 0
            counted += 1
            self.latency_sum += took
            row = self._row(key, t_ms, step, variant, asked, text, answer, took, state_text)
            if self.store:
                self.store.put_call(row)
            out[variant] = row
        self.calls += counted
        self.spent += wall
        self._tick()
        return out

    def _tick(self):
        if not self.progress:
            return
        now = self.clock()
        if self._last_progress is None:
            self._last_progress = now
        late = self.progress_every_s is not None and now - self._last_progress >= self.progress_every_s
        if self.calls >= self._next_progress or late:
            self._next_progress = (self.calls // self.progress_every + 1) * self.progress_every
            self._last_progress = now
            self.progress(self)

    def _call(self, key, t_ms, step, variant, order, question, state_text):
        asked, text = self._prompt(order, question, state_text)
        for _ in range(3):
            self._guard()
            t0 = self.clock()
            answer, took_real, error = self._one_request(text, asked)
            if isinstance(error, llm.ModelUnavailable):
                self.down += 1
                if self.down >= 3:
                    raise ModelDown() from None
                continue
            if error is not None:
                if self.store:
                    self.store.error(key, t_ms, step, variant, error.kind, str(error))
                raise DecisionError(str(error)) from error
            took = self.clock() - t0
            self.down = 0
            self.calls += 1
            self.spent += took
            self.latency_sum += took
            row = self._row(key, t_ms, step, variant, asked, text, answer, took, state_text)
            if self.store:
                self.store.put_call(row)
            self._tick()
            return row
        raise ModelDown()


# --------------------------------------------------------------------------- the engine


class Trader:
    """One product, one position at a time. Feed closed 5m candles in order with ``feed``.

    ``key``: identifier of the run (the block id in the practice; the product in live). ``decider.ask`` is the only thing
    that talks to the model. ``entry_threshold``: minimum p(action) to enter (``cfg['entry_threshold']`` when None).
    """

    def __init__(self, cfg, product, decider, funding=None, *, key=None, entry_threshold=None):
        self.cfg, self.product, self.decider = cfg, product, decider
        self.funding = funding if isinstance(funding, FundingLine) else FundingLine(funding or ())
        self.key = key or product
        threshold = entry_threshold if entry_threshold is not None else cfg.get("entry_threshold")
        if threshold is None:
            raise TraderError("falta el umbral de entrada: config.entry_threshold es null (la práctica pasa el suyo)")
        self.threshold = float(threshold)
        self.questions = questions_for(cfg, product)
        self.notional = D(cfg["notional_usd"])
        self.t, self.o, self.h, self.l, self.c, self.v, self.lc = [], [], [], [], [], [], []
        self.context = {}                 # other products' closes {product: {bar end ms: close}} (``state_extras``: otros_activos)
        self.positioning = None           # ``positioning_data.PositioningFeed`` of this product (``state_ficha``: renglón F6)
        self.position = None
        self.cooldown_until = 0
        self.last_call_ms = None
        self.trade_seq = 0
        self.hooks = [WAKE_HOOKS[name] for name in cfg["wake"].get("hooks", [])]
        self.skip_entry_reason = runtime_of(cfg)["skip_entry_reason"]
        # Live operator only (off in the practice): while flat the wake is an opportunity window (see ``_decide_window``).
        self.force_idle_ms = None         # optional start delay (ms without opening) before the window; None / 0: no delay
        self.window_on = False            # live exploration: while flat, the wake is the opportunity window
        self.idle_since_ms = None         # reference when nothing was opened yet (process start / last opening in the database)
        self.last_open_ms = None
        self.window = None                # opportunity window: {"start_ms", "looks", "best"} while open

    # ---- data

    def _append(self, candle):
        close = float(candle["close"])
        self.t.append(int(candle["bucket_start"]))
        self.o.append(float(candle["open"]))
        self.h.append(float(candle["high"]))
        self.l.append(float(candle["low"]))
        self.c.append(close)
        self.v.append(float(candle["volume_btc"]))
        self.lc.append(math.log(close) if close > 0 else 0.0)
        if len(self.c) > MAX_KEEP:
            cut = len(self.c) - (D7 + 300)
            for series in (self.t, self.o, self.h, self.l, self.c, self.v, self.lc):
                del series[:cut]

    def _sigma5(self):
        lc = self.lc[-(H24 + 1):]
        return _std([b - a for a, b in zip(lc, lc[1:])])

    def _logret(self, bars):
        return self.lc[-1] - self.lc[-1 - bars]

    # ---- wake rules

    def _strong_move(self, sigma5):
        wake = self.cfg["wake"]
        for minutes in wake["strong_move_windows_min"]:
            bars = minutes // 5
            if sigma5 > 0 and abs(self._logret(bars)) > wake["strong_move_sigmas"] * sigma5 * math.sqrt(bars):
                return True
        return False

    def _big_move(self):
        """v2: the price is far (either way) from the entry, in daily volatilities. Only a reason to ask again."""
        position, k = self.position, self.cfg["wake"].get("position_big_move_sigma_24h")
        if position is None or not k:
            return False
        sigma24 = self._sigma5() * math.sqrt(H24)
        return sigma24 > 0 and abs(self.c[-1] / position.entry_ref - 1) >= k * sigma24

    def _near_stop(self):
        position = self.position
        if position is None or not position.stop_pct:
            return False
        adverse = (position.entry_ref - self.c[-1]) / position.entry_ref if position.side == "LONG" else \
            (self.c[-1] - position.entry_ref) / position.entry_ref
        return adverse >= self.cfg["wake"]["near_stop_share"] * position.stop_pct

    def wake_reasons(self, t_ms):
        """Why Qwen should be asked now (``[]``: no). Pure function of the closed candles up to ``t_ms`` and the state."""
        wake = self.cfg["wake"]
        in_position = self.position is not None
        every = wake["position_every_min"] if in_position else wake["flat_every_min"]
        reasons = []
        boundary = t_ms % (every * MINUTE_MS) == 0
        if boundary:
            reasons.append("cada_{}_min".format(every) if in_position or every != 60 else "hora_cerrada")
        if wake.get("extra_wakes", True) is False:
            # Live operator: Qwen is asked ONLY on the boundary (every ``flat_every_min`` / ``position_every_min``). No strong
            # move, near-stop, big-move, funding or hook wake, ever. Configs without the key keep every extra wake.
            return reasons
        extras = []
        sigma5 = self._sigma5()
        if self._strong_move(sigma5):
            extras.append("movimiento_fuerte")
        if in_position and "near_stop_share" in wake and self._near_stop():
            extras.append("cerca_del_stop")
        gap = wake["extra_wake_min_gap_min"] * MINUTE_MS
        if extras and (boundary or self.last_call_ms is None or t_ms - self.last_call_ms >= gap):
            reasons += extras
        if in_position and self._big_move() and (boundary or self.last_call_ms is None or t_ms - self.last_call_ms >=
                                                  wake["position_big_move_gap_min"] * MINUTE_MS):
            reasons.append("movimiento_grande_en_posicion")      # v2: informative only, forces nothing
        published = self.funding.published(t_ms - BAR_MS, t_ms)
        if published is not None:
            previous, new = published
            if abs(new) >= wake["funding_extreme_abs_rate"] or (
                    previous is not None and abs(new - previous) >= wake["funding_change_abs_rate"]):
                reasons.append("funding")
        for hook in self.hooks:
            reasons += list(hook(self, t_ms))
        return reasons

    # ---- state text

    def _x_otros_activos(self, t_ms, sg):
        """Returns of the context assets and the relative strength of this product (text without a heading), or ``None``."""
        parts, last = [], self.c[-1]
        for product, closes in sorted(self.context.items()):
            now = closes.get(t_ms)
            rets = []
            for name, bars in (("1h", H1), ("4h", H4), ("24h", H24)):
                before = closes.get(t_ms - bars * BAR_MS)
                rets.append("{} {} %".format(name, "n/d" if not now or not before else es(sg * (now / before - 1) * 100, 2, True)))
            parts.append("{}: {}".format(product.replace("PF_", "").replace("USD", ""), " | ".join(rets)))
            before = closes.get(t_ms - H4 * BAR_MS)
            if now and before:
                gap = sg * ((last / self.c[-1 - H4] - 1) - (now / before - 1)) * 100
                parts.append("fuerza de {} contra el activo en 4h: {} puntos".format(
                    self.product.replace("PF_", "").replace("USD", ""), es(gap, 2, True)))
        return "; ".join(parts) if parts else None

    @staticmethod
    def _x_hora(t_ms):
        """Day, UTC hour and session: it has no direction, so the mirror leaves it as it is."""
        moment = time.gmtime(t_ms / 1000)
        session = ("Asia" if moment.tm_hour < 8 else "Europa" if moment.tm_hour < 14 else
                   "EE. UU." if moment.tm_hour < 21 else "cierre de EE. UU. / noche")
        return "{} {:02d}:00 UTC (sesión de {}).".format(
            ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")[moment.tm_wday], moment.tm_hour, session)

    def _extra_lines(self, t_ms, sg):
        """Optional extra context (``cfg['state_extras']``, quick-test variants only): other assets, the hour, and the shape of
        the range. Everything that has a direction flips with ``sg`` in the mirror; the hour and the sizes do not."""
        extras = self.cfg.get("state_extras") or ()
        out, last = [], self.c[-1]
        if "otros_activos" in extras:
            others = self._x_otros_activos(t_ms, sg)
            if others:
                out.append("Otros activos (retornos): " + others)
        if "hora" in extras:
            out.append("Momento: " + self._x_hora(t_ms))
        if "volatilidad" in extras:
            hi24, lo24 = max(self.h[-H24:]), min(self.l[-H24:])
            ranges = [(max(self.h[-(d + 1) * H24:len(self.h) - d * H24]) - min(self.l[-(d + 1) * H24:len(self.l) - d * H24]))
                      / last for d in range(7)]
            since_hi = (len(self.h) - 1 - (len(self.h) - H24 + self.h[-H24:].index(hi24))) * 5 / 60.0
            since_lo = (len(self.l) - 1 - (len(self.l) - H24 + self.l[-H24:].index(lo24))) * 5 / 60.0
            if sg < 0:
                since_hi, since_lo = since_lo, since_hi
            out.append("Rango de las últimas 24h: {} % (promedio de los últimos 7 días: {} %). Horas desde el máximo de 24h: {} "
                       "| desde el mínimo de 24h: {}.".format(es((hi24 - lo24) / last * 100, 2), es(math.fsum(ranges) / 7 * 100, 2),
                                                             es(since_hi, 1), es(since_lo, 1)))
        return out

    def state_text(self, t_ms, reasons, mirror=False):
        """The STATE shown to Qwen. ``mirror`` (v3, flat only): the same market with the signs turned over (what went up went
        down; highs and lows swapped; funding with the opposite sign). Volatility, volume and costs do not change."""
        if mirror and self.position is not None:
            raise ValueError("el espejo solo se pregunta sin posición")
        c, last = self.c, self.c[-1]
        sg = -1.0 if mirror else 1.0
        if self.cfg.get("state_corta"):        # version 8 of the live config: the short sheet (maestro, portero, volatility, position)
            from . import futures_qwen_corta as corta
            return corta.state(self, t_ms, sg, reasons)
        sigma5 = self._sigma5()
        lines = ["Mercado (velas cerradas; sin fechas ni precios absolutos). Despertaste por: {}.".format(
            ", ".join(reasons))]
        if self.cfg.get("state_ficha"):        # quick-test variants "ficha": the 8 numbered factors instead of the plain lines
            from . import futures_qwen_ficha as ficha
            cost = "Costo de entrar y salir: ~{} % del tamaño".format(es(float(round_trip_cost_bps(self.product)) / 100.0, 2))
            if self.cfg.get("state_ficha_layout") == "prefijo":     # fixed text first, the photo's data last (cached prefix)
                return ficha.prefixed(self, t_ms, sg, reasons, cost, self._state_tail([], t_ms, sigma5))
            lines.extend(ficha.lines(self, t_ms, sg))
            lines.append(cost)
            return self._state_tail(lines, t_ms, sigma5)
        rets, zs = [], []
        for name, bars in (("1h", H1), ("4h", H4), ("24h", H24), ("7d", D7)):
            ret = sg * (last / c[-1 - bars] - 1)
            z = sg * self._logret(bars) / (sigma5 * math.sqrt(bars)) if sigma5 > 0 else 0.0
            rets.append("{} {} %".format(name, es(ret * 100, 2, True)))
            zs.append("{} {}".format(name, es(z, 1, True)))
        lines.append("Retornos: " + " | ".join(rets))
        lines.append("Tendencia (retorno dividido por el ruido normal de ese plazo; cerca de 0 es lateral, +-2 es fuerte): "
                     + " | ".join(zs))
        sigma24 = sigma5 * math.sqrt(H24)
        lc7 = self.lc[-(D7 + 1):]
        sigma7 = _std([b - a for a, b in zip(lc7, lc7[1:])]) * math.sqrt(H24)
        move15 = sg * self._logret(3)
        lines.append("Volatilidad diaria: ultimas 24h {} % | ultimos 7d {} %. Movimiento de los ultimos 15 min {} % "
                     "(lo normal es +-{} %)".format(es(sigma24 * 100), es(sigma7 * 100), es(move15 * 100, 2, True),
                                                    es(sigma5 * math.sqrt(3) * 100)))
        hi24, lo24, hi7, lo7 = max(self.h[-H24:]), min(self.l[-H24:]), max(self.h[-D7:]), min(self.l[-D7:])
        d_hi24, d_lo24, d_hi7, d_lo7 = (last / hi24 - 1) * 100, (last / lo24 - 1) * 100, (last / hi7 - 1) * 100, \
            (last / lo7 - 1) * 100
        if mirror:
            d_hi24, d_lo24, d_hi7, d_lo7 = -d_lo24, -d_hi24, -d_lo7, -d_hi7
        lines.append("Distancia al maximo / minimo de 24h: {} % / {} % | de 7d: {} % / {} %".format(
            es(d_hi24, 1, True), es(d_lo24, 1, True), es(d_hi7, 1, True), es(d_lo7, 1, True)))
        v1h, v24, v7 = math.fsum(self.v[-H1:]), math.fsum(self.v[-H24:]), math.fsum(self.v[-D7:])
        rel1 = v1h / (v24 / 24) if v24 > 0 else 0.0
        rel24 = v24 / (v7 / 7) if v7 > 0 else 0.0
        lines.append("Volumen: ultima hora x{} del promedio por hora de 24h | 24h x{} del promedio diario de 7d".format(
            es(rel1, 1), es(rel24, 1)))
        latest = self.funding.latest(t_ms)
        if latest is None:
            lines.append("Funding: n/d")
        else:
            pct = self.funding.percentile(t_ms)
            rate = sg * latest[1]
            if mirror and pct is not None:
                pct = 100.0 - pct
            lines.append("Funding: ultima tasa por hora {} % ({}){}".format(
                es(rate * 100, 4, True), "los largos pagan" if rate > 0 else
                "los cortos pagan" if rate < 0 else "nadie paga",
                "" if pct is None else ", percentil {} de los ultimos 30 dias".format(int(round(pct)))))
        lines.append("Costo de entrar y salir: ~{} % del tamaño".format(
            es(float(round_trip_cost_bps(self.product)) / 100.0, 2)))
        lines.extend(self._extra_lines(t_ms, sg))
        return self._state_tail(lines, t_ms, sigma5)

    def _state_tail(self, lines, t_ms, sigma5):
        """The fixed rules and the position, by ``state_variant`` (1: the original, 2: no stop, 3: the live operator's)."""
        guard, last = self.cfg["guardrails"], self.c[-1]
        if self.cfg.get("state_variant", 1) >= 3:
            return self._state_v3(lines, t_ms, sigma5)
        if self.cfg.get("state_variant", 1) >= 2:
            return self._state_v2(lines, t_ms, sigma5)
        lines.append("Reglas fijas que no podés cambiar: stop automatico a {} x la volatilidad diaria; cierre obligatorio "
                     "a las {} h; espera de {} min despues de cerrar; tamaño fijo de 100 USD; una sola posicion; "
                     "sin limite de operaciones por dia.".format(es(guard["stop_sigma_24h"], 1),
                                                                   guard["max_hold_min"] // 60, guard["cooldown_min"]))
        position = self.position
        if position is None:
            lines.append("Posicion: ninguna.")
        else:
            now = settle(self.product, position, last, "strategy_exit", t_ms, self.funding, self.notional)
            to_stop = (last - position.stop_px) / last if position.side == "LONG" else (position.stop_px - last) / last
            left = position.entry_ms + position.max_hold_ms - t_ms
            lines.append("Posicion: {} abierta hace {}. Resultado si cerras ahora (ya con costos): {} %. Distancia al "
                         "stop: {} %. Tiempo hasta el cierre obligatorio: {}.".format(
                             "LARGO" if position.side == "LONG" else "CORTO", _hm((t_ms - position.entry_ms) / MINUTE_MS),
                             es(now["net_bp"] / 100.0, 2, True), es(to_stop * 100, 2), _hm(left / MINUTE_MS)))
        return "\n".join(lines)

    def _state_v3(self, lines, t_ms, sigma5):
        """Tail of the state of the live operator (``state_variant`` 3): the exit facts of v2 (result after all costs, the fee
        logic, typical moves) PLUS the fixed rules that really exist here: automatic stop and a time limit. Facts only."""
        guard = self.cfg["guardrails"]
        lines.append("Reglas fijas que no podés cambiar: stop automatico a {} x la volatilidad diaria (entre {} % y {} % del "
                     "precio); cierre obligatorio a las {} h; espera de {} min despues de cerrar; tamaño fijo de {} USD; "
                     "una sola posicion; sin limite de operaciones por dia. Solo te consultamos cada {} min.".format(
                         es(guard["stop_sigma_24h"], 1), es(guard["min_stop_pct"] * 100, 1), es(guard["max_stop_pct"] * 100, 1),
                         guard["max_hold_min"] // 60, guard["cooldown_min"], format(self.notional.normalize(), "f"),
                         self.cfg["wake"]["position_every_min"]))
        position, last = self.position, self.c[-1]
        if position is None:
            lines.append("Posicion: ninguna.")
            return "\n".join(lines)
        now = settle(self.product, position, last, "strategy_exit", t_ms, self.funding, self.notional)
        exit_cost = float(fee_rate("taker") * 10_000 + side_impact_bps(self.product)) / 100.0
        sign = 1.0 if position.side == "LONG" else -1.0
        captured = sign * (last / position.entry_ref - 1.0) * 100.0
        to_stop = (last - position.stop_px) / last if position.side == "LONG" else (position.stop_px - last) / last
        left = position.entry_ms + position.max_hold_ms - t_ms
        lines.append("Posicion: {} abierta hace {}.".format("LARGO" if position.side == "LONG" else "CORTO",
                                                           _hm((t_ms - position.entry_ms) / MINUTE_MS)))
        lines.append("Resultado si cerras ahora, ya con todos los costos: {} % ({} USD).".format(
            es(now["net_bp"] / 100.0, 2, True), es(now["net_bp"] / 100.0 * float(self.notional) / 100.0, 2, True)))
        lines.append("La comision de entrada ya esta pagada y ya esta en ese resultado; cerrar solo agrega la de salida "
                     "(~{} % del tamaño).".format(es(exit_cost, 2)))
        lines.append("Distancia al stop automatico: {} %. Tiempo hasta el cierre obligatorio: {}.".format(
            es(to_stop * 100, 2), _hm(left / MINUTE_MS)))
        lines.append("Movimiento tipico del precio esperable (segun la volatilidad actual): proxima 1h +-{} % | proximas "
                     "4h +-{} %. Movimiento a favor de la posicion desde que abriste, sin costos: {} %.".format(
                         es(sigma5 * math.sqrt(H1) * 100, 2), es(sigma5 * math.sqrt(H4) * 100, 2), es(captured, 2, True)))
        return "\n".join(lines)

    def _state_v2(self, lines, t_ms, sigma5):
        """v2 tail of the state: no stop, no time limit; the exit decision gets the after-cost result, the fee logic and the
        size of the moves to expect. Facts only, no hint about what to choose."""
        guard, last = self.cfg["guardrails"], self.c[-1]
        lines.append("Reglas fijas que no podés cambiar: espera de {} min despues de cerrar; tamaño fijo de 100 USD; una sola "
                     "posicion; sin limite de operaciones por dia. No hay stop ni limite de tiempo: la posicion solo se "
                     "cierra cuando la cerras.".format(guard["cooldown_min"]))
        position = self.position
        if position is None:
            lines.append("Posicion: ninguna.")
            return "\n".join(lines)
        now = settle(self.product, position, last, "strategy_exit", t_ms, self.funding, self.notional)
        exit_cost = float(fee_rate("taker") * 10_000 + side_impact_bps(self.product)) / 100.0
        sign = 1.0 if position.side == "LONG" else -1.0
        captured = sign * (last / position.entry_ref - 1.0) * 100.0
        lines.append("Posicion: {} abierta hace {}.".format("LARGO" if position.side == "LONG" else "CORTO",
                                                           _hm((t_ms - position.entry_ms) / MINUTE_MS)))
        lines.append("Resultado si cerras ahora, ya con todos los costos: {} % ({} USD).".format(
            es(now["net_bp"] / 100.0, 2, True), es(now["net_bp"] / 100.0 * float(self.notional) / 100.0, 2, True)))
        lines.append("La comision de entrada ya esta pagada y ya esta en ese resultado; cerrar solo agrega la de salida "
                     "(~{} % del tamaño).".format(es(exit_cost, 2)))
        lines.append("Movimiento tipico del precio esperable (segun la volatilidad actual): proxima 1h +-{} % | proximas "
                     "4h +-{} %. Movimiento a favor de la posicion desde que abriste, sin costos: {} %.".format(
                         es(sigma5 * math.sqrt(H1) * 100, 2), es(sigma5 * math.sqrt(H4) * 100, 2), es(captured, 2, True)))
        return "\n".join(lines)

    # ---- feeding

    def feed(self, candle, trade=True):
        """One CLOSED 5m candle. Returns the events it caused: ``decision``, ``guardrail`` and ``trade`` dicts.

        ``trade=False`` only warms the history up (no guardrail, no wake, no model)."""
        bucket = int(candle["bucket_start"])
        if self.t and bucket != self.t[-1] + BAR_MS:
            raise ValueError("velas de 5m no contiguas: {} despues de {}".format(bucket, self.t[-1]))
        self._append(candle)
        t_ms = bucket + BAR_MS
        if not trade or len(self.c) < MIN_BARS:
            return []
        events = []
        if self.position is not None:
            events += self._guardrails(bucket, t_ms)
            if self.position is None:
                return events
        if self.position is None and t_ms < self.cooldown_until:
            return events
        reasons = self.wake_reasons(t_ms)
        if reasons:
            try:
                events += self._decide(t_ms, reasons)
            except WakeSkipped as skip:
                events.append({"type": "skipped", "t_ms": t_ms, "wake": list(reasons), "kind": skip.kind,
                               "detail": skip.detail})
        return events

    def _guardrails(self, bucket, t_ms):
        position = self.position
        long = position.side == "LONG"
        high, low, open_ = self.h[-1], self.l[-1], self.o[-1]
        ref = position.entry_ref
        best, worst = ((high / ref - 1) * 1e4, (low / ref - 1) * 1e4) if long else ((1 - low / ref) * 1e4,
                                                                                    (1 - high / ref) * 1e4)
        position.mfe_bp = max(position.mfe_bp, best)
        position.mae_bp = min(position.mae_bp, worst)
        touched = position.stop_px is not None and (low <= position.stop_px if long else high >= position.stop_px)
        if touched:
            level = min(position.stop_px, open_) if long else max(position.stop_px, open_)
            return self._close(t_ms, level, "stop", "stop", None)
        if position.max_hold_ms is not None and t_ms - position.entry_ms >= position.max_hold_ms:
            return self._close(t_ms, self.c[-1], "strategy_exit", "tiempo", None)
        return []

    def force_close(self, reason="fin_de_bloque"):
        """Closes the open position at the last close (end of a practice block). Not a Qwen decision."""
        if self.position is None:
            return []
        return self._close(self.t[-1] + BAR_MS, self.c[-1], "strategy_exit", reason, None)

    def _close(self, t_ms, ref_price, cost_reason, closed_by, exit_reason):
        position = self.position
        done = settle(self.product, position, ref_price, cost_reason, t_ms, self.funding, self.notional)
        trade = {"trade_no": position.trade_no, "product": self.product, "side": position.side,
                 "entry_ms": position.entry_ms, "exit_ms": t_ms, "entry_px": float(position.entry_px),
                 "exit_px": float(done["exit_px"]), "net_bp": done["net_bp"], "gross_bp": done["gross_bp"],
                 "funding_bp": done["funding_bp"], "funding_status": done["funding_status"], "closed_by": closed_by,
                 "hold_min": int((t_ms - position.entry_ms) // MINUTE_MS), "entry_p": position.entry_p,
                 "entry_reason": position.entry_reason, "exit_reason": exit_reason,
                 "mfe_bp": round(position.mfe_bp, 2), "mae_bp": round(position.mae_bp, 2),
                "net_usd": str(done["net_usd"]), "gross_usd": str(done["gross_usd"]), "fees_usd": str(done["fees_usd"]),
                "funding_usd": str(done["funding_usd"]), "qty": str(position.qty), "entry_fill": str(position.entry_px)}
        self.position = None
        self.cooldown_until = t_ms + self.cfg["guardrails"]["cooldown_min"] * MINUTE_MS
        events = []
        if closed_by not in ("qwen", "formula"):
            events.append({"type": "guardrail", "kind": "guardrail", "t_ms": t_ms, "guardrail": closed_by, "action": "CERRAR",
                           "trade_no": trade["trade_no"], "position": position.snapshot(), "net_bp_now": done["net_bp"]})
        events.append({"type": "trade", "trade": trade})
        return events

    def _open(self, t_ms, side, probability, reason):
        guard = self.cfg["guardrails"]
        last = self.c[-1]
        stop_pct = None                                  # v2: no stop (config guardrails.stop_sigma_24h is null)
        if guard["stop_sigma_24h"] is not None:
            stop_pct = guard["stop_sigma_24h"] * self._sigma5() * math.sqrt(H24)
            stop_pct = min(guard["max_stop_pct"], max(guard["min_stop_pct"], stop_pct))
        entry = entry_fill(D(repr(last)), side, self.product)
        self.last_open_ms = t_ms
        self.trade_seq += 1
        self.position = Position(
            side=side, entry_ms=t_ms, entry_ref=last, entry_px=entry, qty=self.notional / entry,
            stop_px=None if stop_pct is None else (last * (1 - stop_pct) if side == "LONG" else last * (1 + stop_pct)),
            stop_pct=stop_pct, max_hold_ms=None if guard["max_hold_min"] is None else guard["max_hold_min"] * MINUTE_MS, entry_p=probability, entry_reason=reason,
            trade_no=self.trade_seq, mfe_bp=0.0, mae_bp=0.0)

    def _passes_mirror(self, t_ms, reasons, action, event):
        """v3 mirror test: the same question about the mirrored STATE must give the opposite side. Anything else (the same
        side, or waiting) means the answer did not come from the numbers: no entry, ``override`` = ``espejo``."""
        try:
            mirror = self.decider.ask(self.key, t_ms, "mirror", self.questions["flat"],
                                      self.state_text(t_ms, reasons, mirror=True))
        except DecisionError:
            event["override"] = "espejo_sin_respuesta"
            return False
        event.update(mirror_action=mirror["chosen"], mirror_p=mirror["probabilities"][mirror["chosen"]])
        if not mirror_passes(action, mirror["chosen"]):
            event["override"] = "espejo"
            return False
        return True

    def _force_ref(self):
        return self.last_open_ms if self.last_open_ms is not None else self.idle_since_ms

    def _force_due(self, t_ms):
        """Live exploration: while flat (the cooldown is checked by ``feed``) every wake belongs to the opportunity window. It
        starts as soon as the product is flat and out of cooldown; ``force_idle_ms`` (default none) is an optional delay counted
        from the last opening on record, or from the process start. Opening a position ends the window."""
        question = (self.cfg.get("live") or {}).get("force_question") or self.cfg.get("factors")
        if not (self.window_on and question):
            return False
        if self.window is not None or not self.force_idle_ms:
            return True
        ref = self._force_ref()
        return ref is not None and t_ms - ref > self.force_idle_ms

    def _decide_window(self, t_ms, reasons, event):
        """Opportunity window, always on while flat. Every 15 min wake of the window asks the two-option question (LARGO / CORTO, both option
        orders) about the real numbers AND about the mirrored ones. ``lean`` = p(LARGO) - p(CORTO); ``lean_num`` =
        (lean - lean_m) / 2, the part of the lean that comes from the numbers; score = |lean_num|, side = its sign. A look is a
        CANDIDATE only when the mirror does NOT repeat the same side (``lean_eff * lean_m_eff <= 0``, where each lean counts as 0 when it is under
        ``force_neutral_lean``: a 50/50 is noise, not a side, on the real state or on the mirror) AND ``score >= force_min_score``. It enters when it is a candidate AND its
        score reaches the best candidate score of the window minus ``force_record_tol`` AND at least ``force_min_looks`` looks came before; after
        ``force_window_h`` hours it enters at the first candidate with no record required. A contradicting mirror never
        enters. The look is stored as a wait (``ventana_mirando``); the entry as ``entrada_ventana`` / entry reason ``ventana``.

        With ``cfg["factors"]`` (live config, version 5) the two questions of letters are replaced by one factors call on the real
        STATE and one on the mirrored one (``decider.ask_factors``): ``lean`` = (sum of the 6 voting gradients) / 12 of the real
        answer, ``lean_m`` the same on the mirror, ``lean_num`` = (lean - lean_m) / 2 as above, and the event also carries
        ``factors`` (the 8 gradients of both answers and the reading per line) for the Terminal. ``live.force_question`` is not used."""
        live = self.cfg["live"]
        window = self.window
        if window is None:
            window = self.window = {"start_ms": t_ms, "looks": 0, "best": 0.0}
        ref = self._force_ref()
        hours = 0.0 if ref is None else max(0.0, (t_ms - ref) / HOUR_MS)
        if self.cfg.get("factors"):
            # Version 5 of the live config: ONE factors call on the real STATE and ONE on the mirrored one (gradient of -2 to +2 per
            # line, ``futures_qwen_factors``). lean = sum of F1 F2 F3 F4 F6 F7 / 12; the rest of the window is exactly the same.
            from . import futures_qwen_factors as fq
            try:
                real = self.decider.ask_factors(self.key, t_ms, "force", event["state_text"])
                mirror = self.decider.ask_factors(self.key, t_ms, "force_mirror", self.state_text(t_ms, reasons, mirror=True))
            except DecisionError:
                event["override"] = "sin_respuesta"
                return [event]
            look = fq.window_look(real, mirror)
            lean, lean_m, lean_num = look["lean"], look["lean_m"], look["lean_num"]
            real_answer, mirror_action, mirror_p = look["answer"], look["mirror_action"], look["mirror_p"]
            event["factors"] = look["factors"]
        else:
            spec = live["force_question"]
            question = dict(spec, instruction=spec["instruction"].replace("{hours}", es(hours, 1)))
            try:
                real = self.decider.ask(self.key, t_ms, "force", question, event["state_text"])
                mirror = self.decider.ask(self.key, t_ms, "force_mirror", question, self.state_text(t_ms, reasons, mirror=True))
            except DecisionError:
                event["override"] = "sin_respuesta"
                return [event]
            lean = real["probabilities"]["LARGO"] - real["probabilities"]["CORTO"]
            lean_m = mirror["probabilities"]["LARGO"] - mirror["probabilities"]["CORTO"]
            lean_num = (lean - lean_m) / 2.0
            real_answer, mirror_action, mirror_p = real, mirror["chosen"], mirror["probabilities"][mirror["chosen"]]
        score = abs(lean_num)
        side = "LARGO" if lean_num > 0 else "CORTO"
        neutral = live.get("force_neutral_lean", 0.05)
        lean_eff = lean if abs(lean) >= neutral else 0.0              # a 50/50 is noise, not a side: on the real state...
        lean_m_eff = lean_m if abs(lean_m) >= neutral else 0.0        # ...and on the mirrored one
        candidate = not (lean_eff * lean_m_eff > 0) and score >= live.get("force_min_score", 0.15)
        looks_before, best_before = window["looks"], window["best"]
        late = t_ms - window["start_ms"] >= live.get("force_window_h", 12) * HOUR_MS
        enter = candidate and ((looks_before >= live.get("force_min_looks", 6)
                                      and score >= best_before - live.get("force_record_tol", 0.03)) or late)
        window["looks"] += 1
        if candidate:                      # solo las candidatas (espejo coincidente) suben la vara
            window["best"] = max(best_before, score)
        event.update(answer=real_answer, model_action=side, p_action=real_answer["probabilities"][side], threshold=None,
                     mirror_action=mirror_action, mirror_p=mirror_p,
                     lean=lean, lean_m=lean_m, lean_num=lean_num, lean_eff=lean_eff, score=score, best_score=window["best"],
                     look_n=window["looks"], mirror_ok=candidate, idle_hours=round(hours, 2), override="ventana_mirando")
        if not enter:
            return [event]
        event.update(action=side, override="entrada_ventana", reason="entrada_ventana", forced=True)
        self._open(t_ms, "LONG" if side == "LARGO" else "SHORT", event["p_action"], "ventana")
        self.window = None
        event["trade_no"] = self.position.trade_no
        return [event]

    def _decide_formula(self, t_ms, reasons, event, state, question):
        """Version 9: the FORMULAS decide (maestro and portero, ``futures_qwen_corta.formula_action``) and Qwen gives an opinion
        next to them with the same sheet: it is asked the same question and what it says is kept in the decision (``model_action``,
        probabilities, ``reason``) but never opens or closes anything. A model that is down or slow, or an unusable answer, leaves
        the opinion empty; the formula still decides (a wake that is too old or already decided is still skipped by the gate)."""
        from . import futures_qwen_corta as corta
        in_position = self.position is not None
        readings = corta.readings(self, t_ms)
        action, why = corta.formula_action(readings, None if not in_position else (1 if self.position.side == "LONG" else -1))
        event.update(formula_action=action, formula=corta.formula_json(readings, why), action=action, override=None)
        try:
            answer = self.decider.ask(self.key, t_ms, "action", question, state)
        except DecisionError:
            event["opinion_error"] = "sin_respuesta"
            answer = None
        except WakeSkipped as skip:
            if skip.kind not in ("modelo_caido", "modelo_lento"):
                raise
            event["opinion_error"] = skip.kind
            answer = None
        if answer is not None:
            opinion = answer["chosen"]
            event.update(answer=answer, model_action=opinion, p_action=answer["probabilities"][opinion],
                         opinion_agrees=opinion == action)
            if opinion != action or opinion in ("LARGO", "CORTO", "CERRAR"):
                try:
                    asked = self.decider.ask(self.key, t_ms, "reason", dict(
                        self.questions["reason"], instruction=self.questions["reason"]["instruction"].replace("{action}", opinion)),
                        state, single=self.cfg["prompt"].get("reason_orders") != "both")
                    event.update(reason_answer=asked, reason=asked["chosen"])
                except (DecisionError, WakeSkipped) as error:
                    if isinstance(error, WakeSkipped) and error.kind not in ("modelo_caido", "modelo_lento"):
                        raise
                    event["opinion_error"] = "motivo_sin_respuesta"
        if action in ("LARGO", "CORTO"):
            self._open(t_ms, "LONG" if action == "LARGO" else "SHORT", readings["portero_p"], "formula")
            event["trade_no"] = self.position.trade_no
            return [event]
        if action == "CERRAR":
            return [event] + self._close(t_ms, self.c[-1], "strategy_exit", "formula", "maestro_vuelta")
        return [event]

    def _decide(self, t_ms, reasons):
        self.last_call_ms = t_ms
        in_position = self.position is not None
        kind = "position" if in_position else "flat"
        if self.cfg.get("state_corta"):
            from . import futures_qwen_corta as corta
            corta.check(self, t_ms)              # incomplete data: the wake is omitted, Qwen is not asked (WakeSkipped)
        state = self.state_text(t_ms, reasons)
        question = self.questions["position" if in_position else "flat"]
        net_now = None
        snapshot = None
        if in_position:
            snapshot = self.position.snapshot()
            net_now = settle(self.product, self.position, self.c[-1], "strategy_exit", t_ms, self.funding,
                             self.notional)["net_bp"]
        event = {"type": "decision", "kind": kind, "t_ms": t_ms, "wake": list(reasons), "state_text": state,
                 "state_hash": llm.text_hash(state)[:16], "position": snapshot, "net_bp_now": net_now,
                 "threshold": None if in_position else self.threshold, "answer": None, "model_action": None,
                 "p_action": None, "mirror_action": None, "mirror_p": None,
                 "action": "MANTENER" if in_position else "ESPERAR", "override": None,
                 "reason": None, "reason_answer": None, "trade_no": self.position.trade_no if in_position else None}
        if self.cfg.get("decide_by") == "formula":
            return self._decide_formula(t_ms, reasons, event, state, question)
        if not in_position and self._force_due(t_ms):
            return self._decide_window(t_ms, reasons, event)
        try:
            answer = self.decider.ask(self.key, t_ms, "action", question, state)
        except DecisionError:
            event["override"] = "sin_respuesta"
            return [event]
        event.update(answer=answer, model_action=answer["chosen"], p_action=answer["probabilities"][answer["chosen"]])
        action = answer["chosen"]
        wants_move = action in ("LARGO", "CORTO", "CERRAR")
        if wants_move and not in_position and event["p_action"] < self.threshold:
            event["override"] = "bajo_umbral"
            wants_move = False
        if wants_move and not in_position and self.cfg.get("mirror"):
            wants_move = self._passes_mirror(t_ms, reasons, action, event)
        if not wants_move:
            return [event]
        reason = None
        if not in_position and self.skip_entry_reason:
            # ``runtime.skip_entry_reason``: the entry reason is degenerate (95 % «tendencia»), so it is not asked at all
            event.update(action=action, reason=None)
            self._open(t_ms, "LONG" if action == "LARGO" else "SHORT", event["p_action"], None)
            event["trade_no"] = self.position.trade_no
            return [event]
        try:
            asked = self.decider.ask(self.key, t_ms, "reason", dict(
                self.questions["reason"], instruction=self.questions["reason"]["instruction"].replace("{action}", action)),
                state, single=self.cfg["prompt"].get("reason_orders") != "both")
            event["reason_answer"], reason = asked, asked["chosen"]
        except DecisionError:
            reason = "otro"
            event["override"] = "motivo_sin_respuesta"
        event.update(action=action, reason=reason)
        if in_position:
            return [event] + self._close(t_ms, self.c[-1], "strategy_exit", "qwen", reason)
        self._open(t_ms, "LONG" if action == "LARGO" else "SHORT", event["p_action"], reason)
        event["trade_no"] = self.position.trade_no
        return [event]


# --------------------------------------------------------------------------- history (holdout-safe)


class History:
    """Kraken's public 5m candles and funding through a local cache. Refuses anything that reaches the holdout."""

    def __init__(self, cache_dir, holdout_ms, *, offline=False, fetch=None, fetch_funding_fn=None):
        self.cache_dir, self.holdout_ms, self.offline = cache_dir, holdout_ms, offline
        self._fetch = fetch
        self._fetch_funding = fetch_funding_fn or fetch_funding
        self.max_requested_ms = 0

    def _check(self, to_ms):
        if to_ms > self.holdout_ms:
            raise HoldoutError("se pidieron datos hasta {} y el corte (holdout) es {}: no se leen".format(
                stamp(to_ms), stamp(self.holdout_ms)))
        self.max_requested_ms = max(self.max_requested_ms, to_ms)

    def _cache(self, product):
        return CandleCache(os.path.join(self.cache_dir, "candles-{}.sqlite".format(product)))

    def prefetch(self, product, from_ms, to_ms, log=print):
        self._check(to_ms)
        if self.offline:
            return
        cache = self._cache(product)
        try:
            kwargs = {} if self._fetch is None else {"fetch": self._fetch}
            cache.ensure(product, "5m", from_ms, to_ms, **kwargs)
        finally:
            cache.close()
        self.funding(product)

    def bars(self, product, from_ms, to_ms):
        """Gap-filled 5m candles of ``[from_ms, to_ms)``; reads the cache only."""
        self._check(to_ms)
        cache = self._cache(product)
        try:
            return fill_gaps(cache.read(product, "5m", from_ms, to_ms), BAR_MS)
        finally:
            cache.close()

    def funding(self, product):
        """``[(period_start_ms, rate)]`` with every period that starts before the holdout; cached on disk."""
        path = os.path.join(self.cache_dir, "funding-{}.json".format(product))
        rows = None
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                rows = json.load(handle)
        if rows is None:
            if self.offline:
                return []
            rows = [list(r) for r in self._fetch_funding(product)]
            os.makedirs(self.cache_dir, exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(rows, handle)
        return [(int(s), float(r)) for s, r in rows if int(s) + HOUR_MS <= self.holdout_ms]


# --------------------------------------------------------------------------- the block plan


def block_plan(cfg, holdout_ms, *, seed=None, blocks=None, block_days=None, from_date=None):
    """Random contiguous blocks, stratified across time and products, in an order whose every prefix is balanced.

    Slots of ``block_days`` days tile ``[from, holdout)``; strata are ``(product, time bin)``. Each stratum is shuffled with
    the seed and the strata are interleaved round robin, so cutting the list anywhere is a stratified sample. Folds: blocks
    that start before the first 60 % of the period (rounded to a day) are calibration, the rest validation.
    """
    practice = cfg["practice"]
    seed = practice["seed"] if seed is None else seed
    block_days = block_days or practice["block_days"]
    start_ms = date_ms(from_date or practice["from"])
    block_ms = block_days * DAY_MS
    slots = (holdout_ms - start_ms) // block_ms
    if slots < 1:
        raise TraderError("el periodo es más corto que un bloque")
    bins = min(practice["time_bins"], slots)
    cut = start_ms + int((holdout_ms - start_ms) * practice["calibration_share"]) // DAY_MS * DAY_MS
    strata = collections.defaultdict(list)
    for product in cfg["products"]:
        for slot in range(slots):
            strata[(product, slot * bins // slots)].append(slot)
    ranked = []
    for (product, time_bin), items in sorted(strata.items()):
        rng = random.Random("{}:{}:{}".format(seed, product, time_bin))
        rng.shuffle(items)
        ranked += [(rank, rng.random(), product, time_bin, slot) for rank, slot in enumerate(items)]
    ranked.sort(key=lambda row: (row[0], row[1], row[2]))
    plan = []
    for _, _, product, time_bin, slot in ranked[:blocks or practice["target_blocks"]]:
        begin = start_ms + slot * block_ms
        plan.append({"block_id": "{}:{}".format(product, stamp(begin)), "product": product, "start_ms": begin,
                     "end_ms": begin + block_ms, "bin": time_bin, "fold": "calibration" if begin < cut else "validation"})
    return plan, cut


# --------------------------------------------------------------------------- practice database

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY, started_ms INTEGER NOT NULL, ended_ms INTEGER, args TEXT, calls INTEGER, mean_call_s REAL,
  stop_reason TEXT, model_ref TEXT, served_model TEXT);
CREATE TABLE IF NOT EXISTS blocks(
  block_id TEXT PRIMARY KEY, product TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  time_bin INTEGER NOT NULL, fold TEXT NOT NULL, status TEXT NOT NULL, bars INTEGER, wakes INTEGER, seconds REAL,
  finished_ms INTEGER, note TEXT, closes BLOB);
CREATE TABLE IF NOT EXISTS calls(
  block_id TEXT NOT NULL, t_ms INTEGER NOT NULL, step TEXT NOT NULL, variant INTEGER NOT NULL, order_json TEXT NOT NULL,
  probs_json TEXT NOT NULL, chosen TEXT NOT NULL, confidence REAL, source TEXT, latency_ms INTEGER, prompt_hash TEXT,
  prompt_version INTEGER, state_hash TEXT, model TEXT, asked_at_ms INTEGER,
  PRIMARY KEY(block_id, t_ms, step, variant));
CREATE TABLE IF NOT EXISTS call_errors(
  block_id TEXT NOT NULL, t_ms INTEGER NOT NULL, step TEXT NOT NULL, variant INTEGER NOT NULL, kind TEXT, message TEXT,
  asked_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS decisions(
  block_id TEXT NOT NULL, seq INTEGER NOT NULL, t_ms INTEGER NOT NULL, kind TEXT NOT NULL, product TEXT NOT NULL,
  fold TEXT NOT NULL, state_hash TEXT, state_text TEXT, wake_json TEXT, orders_json TEXT, probs_json TEXT,
  confidence REAL, model_action TEXT, p_action REAL, threshold REAL, action TEXT, override TEXT, reason TEXT,
  reason_json TEXT, latency_ms INTEGER, prompt_version INTEGER, prompt_hash TEXT, model TEXT, position_json TEXT,
  net_bp_now REAL, trade_no INTEGER, outcome_json TEXT, PRIMARY KEY(block_id, seq));
CREATE TABLE IF NOT EXISTS trades(
  block_id TEXT NOT NULL, trade_no INTEGER NOT NULL, product TEXT NOT NULL, side TEXT NOT NULL, fold TEXT NOT NULL,
  time_bin INTEGER NOT NULL, entry_ms INTEGER NOT NULL, exit_ms INTEGER NOT NULL, entry_px REAL, exit_px REAL,
  net_bp REAL NOT NULL, gross_bp REAL, funding_bp REAL, funding_status TEXT, closed_by TEXT NOT NULL,
  hold_min INTEGER, entry_p REAL, entry_reason TEXT, exit_reason TEXT, mfe_bp REAL, mae_bp REAL,
  PRIMARY KEY(block_id, trade_no));
"""


class PracticeDB:
    """Single writer of the practice database (the ``practice`` command). Readers open it ``mode=ro``."""

    def __init__(self, path, readonly=False):
        if readonly:
            self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
        else:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            self.db = sqlite3.connect(path)
            self.db.executescript(_SCHEMA_SQL)
        self.db.row_factory = sqlite3.Row

    def close(self):
        self.db.close()

    def meta(self):
        return {r["key"]: json.loads(r["value"]) for r in self.db.execute("SELECT key, value FROM meta")}

    def set_meta(self, key, value):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value)))

    # ---- the store the decider uses

    def calls(self, key, t_ms, step):
        out = {}
        for r in self.db.execute("SELECT * FROM calls WHERE block_id=? AND t_ms=? AND step=?", (key, t_ms, step)):
            out[r["variant"]] = {
                "key": key, "t_ms": t_ms, "step": step, "variant": r["variant"], "order": json.loads(r["order_json"]),
                "probabilities": json.loads(r["probs_json"]), "chosen": r["chosen"], "confidence": r["confidence"],
                "source": r["source"], "latency_ms": r["latency_ms"], "prompt_hash": r["prompt_hash"]}
        return out

    def put_call(self, row):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                row["key"], row["t_ms"], row["step"], row["variant"], json.dumps(row["order"]),
                json.dumps(row["probabilities"]), row["chosen"], row["confidence"], row["source"], row["latency_ms"],
                row["prompt_hash"], row["prompt_version"], row["state_hash"], row["model"], row["asked_at_ms"]))

    def error(self, key, t_ms, step, variant, kind, message):
        with self.db:
            self.db.execute("INSERT INTO call_errors VALUES(?,?,?,?,?,?,?)",
                            (key, t_ms, step, variant, kind, message, int(time.time() * 1000)))

    # ---- blocks

    def done_blocks(self):
        return {r["block_id"] for r in self.db.execute("SELECT block_id FROM blocks WHERE status='done'")}

    def commit_block(self, block, events, decisions_meta, stats, closes):
        """One transaction: the block, its decisions and trades. Either all of it is there or none."""
        with self.db:
            self.db.execute("DELETE FROM decisions WHERE block_id=?", (block["block_id"],))
            self.db.execute("DELETE FROM trades WHERE block_id=?", (block["block_id"],))
            self.db.execute("INSERT OR REPLACE INTO blocks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                block["block_id"], block["product"], block["start_ms"], block["end_ms"], block["bin"], block["fold"],
                "done", stats["bars"], stats["wakes"], stats["seconds"], int(time.time() * 1000), stats.get("note"),
                array.array("d", closes).tobytes()))
            seq = 0
            for ev in events:
                if ev["type"] == "trade":
                    t = ev["trade"]
                    self.db.execute("INSERT INTO trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                        block["block_id"], t["trade_no"], t["product"], t["side"], block["fold"], block["bin"],
                        t["entry_ms"], t["exit_ms"], t["entry_px"], t["exit_px"], t["net_bp"], t["gross_bp"],
                        t["funding_bp"], t["funding_status"], t["closed_by"], t["hold_min"], t["entry_p"],
                        t["entry_reason"], t["exit_reason"], t["mfe_bp"], t["mae_bp"]))
                    continue
                seq += 1
                answer = ev.get("answer")
                first = (answer or {}).get("orders") or [{}]
                self.db.execute("INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                    block["block_id"], seq, ev["t_ms"], ev["kind"], block["product"], block["fold"],
                    ev.get("state_hash"), ev.get("state_text"), json.dumps(ev.get("wake")),
                    json.dumps(first if answer else None), json.dumps(answer["probabilities"] if answer else None),
                    answer["confidence"] if answer else None, ev.get("model_action"), ev.get("p_action"),
                    ev.get("threshold"), ev.get("action"), ev.get("override") or ev.get("guardrail"), ev.get("reason"),
                    json.dumps(ev.get("reason_answer")), answer["latency_ms"] if answer else None,
                    decisions_meta["prompt_version"], first[0].get("prompt_hash"), decisions_meta["model"],
                    json.dumps(ev.get("position")), ev.get("net_bp_now"), ev.get("trade_no"),
                    json.dumps(ev.get("outcome"))))


# --------------------------------------------------------------------------- outcomes


def annotate_outcomes(events, bars, cfg, product, funding):
    """Fills ``outcome`` on every decision, from the candles of the block (labels, never part of the STATE).

    * every flat decision: net bp of a long and of a short held ``outcome_window_min`` minutes, round-trip cost included.
    * entry (LARGO / CORTO executed): besides that, the net result of the trade it opened (``net_bp``, ``closed_by``).
    * position (MANTENER / CERRAR): net bp now vs after the window (the realized result when the trade ended first):
      ``hold_better_bp`` = after - now (> 0: holding was better than closing).
    """
    window = cfg["outcome_window_min"] * MINUTE_MS
    closes = {b["bucket_start"] + BAR_MS: float(b["close"]) for b in bars}
    trades = {ev["trade"]["trade_no"]: ev["trade"] for ev in events if ev["type"] == "trade"}
    cost_bp = float(round_trip_cost_bps(product))
    notional = D(cfg["notional_usd"])
    for ev in events:
        if ev["type"] == "trade":
            continue
        ev["outcome"] = None
        t_ms = ev["t_ms"]
        if ev["kind"] == "flat":
            now, later = closes.get(t_ms), closes.get(t_ms + window)
            out = {"type": "wait", "window_min": cfg["outcome_window_min"], "long_net_bp": None, "short_net_bp": None}
            if now and later:
                move = (later / now - 1) * 1e4
                out.update(long_net_bp=round(move - cost_bp, 2), short_net_bp=round(-move - cost_bp, 2))
            if ev["action"] in ("LARGO", "CORTO") and ev.get("trade_no") in trades:
                t = trades[ev["trade_no"]]
                out.update(type="entry", net_bp=t["net_bp"], closed_by=t["closed_by"], hold_min=t["hold_min"])
            ev["outcome"] = out
            continue
        snapshot = ev["position"]
        if snapshot is None:
            continue
        trade = trades.get(snapshot["trade_no"])
        later = closes.get(t_ms + window)
        after, how = None, None
        if trade is not None and trade["exit_ms"] <= t_ms + window:
            after, how = trade["net_bp"], "closed_" + trade["closed_by"]
        elif later is not None:
            pos = Position(side=snapshot["side"], entry_ms=snapshot["entry_ms"], entry_px=D(snapshot["entry_px"]),
                           qty=D(snapshot["qty"]))
            after, how = settle(product, pos, later, "strategy_exit", t_ms + window, funding, notional)["net_bp"], "marked"
        if after is not None and ev["net_bp_now"] is not None:
            ev["outcome"] = {"type": "position", "window_min": cfg["outcome_window_min"], "net_bp_now": ev["net_bp_now"],
                             "net_bp_after": round(after, 2), "after": how,
                             "hold_better_bp": round(after - ev["net_bp_now"], 2)}
    return events


# --------------------------------------------------------------------------- threshold


def select_threshold(trades, cfg):
    """Entry threshold chosen on the CALIBRATION trades from the predeclared grid.

    Rule (``config.threshold_rule``): among thresholds whose calibration trades (entry_p >= threshold) number at least
    ``min_calibration_trades``, the one with the largest total net bp; ties go to the higher threshold. If none has a
    positive total (or none has enough trades) the most conservative threshold of the grid is used and the reason says so.
    """
    rule = cfg["threshold_rule"]
    rows = []
    for threshold in cfg["entry_threshold_grid"]:
        values = [t["net_bp"] for t in trades if t["entry_p"] is not None and t["entry_p"] >= threshold - 1e-12]
        rows.append({"threshold": threshold, "n": len(values), "total_bp": sum(values),
                     "mean_bp": sum(values) / len(values) if values else None})
    eligible = [r for r in rows if r["n"] >= rule["min_calibration_trades"]]
    best = max(eligible, key=lambda r: (r["total_bp"], r["threshold"]), default=None)
    if best is not None and best["total_bp"] > 0:
        return {"threshold": best["threshold"], "reason": "mayor resultado total en calibración", "rows": rows}
    return {"threshold": max(cfg["entry_threshold_grid"]),
            "reason": "ningún umbral ganó en calibración con suficientes operaciones: se usa el más exigente",
            "rows": rows}


# --------------------------------------------------------------------------- practice


def _eta(seconds):
    return "{:.1f} min".format(seconds / 60.0)


def throughput_line(decider, provider, elapsed_s, blocks, block_seconds):
    """Measured speed of a batch: calls per second, wall seconds per call (a concurrent pair counts once), the latency of one
    call, blocks per hour and, when the server reports it, the share of prompt tokens served from its cache."""
    if not decider.calls:
        return "rendimiento: ninguna llamada nueva en esta tanda"
    text = "rendimiento: {} llamadas nuevas en {} ({:.2f} llamadas/s, {:.2f} s de reloj por llamada, latencia de una llamada " \
           "{:.2f} s, órdenes {})".format(decider.calls, _eta(decider.spent), decider.calls / max(decider.spent, 1e-9),
                                          decider.mean_call(), decider.mean_latency(),
                                          "en paralelo" if decider.concurrency > 1 else "una tras otra")
    if blocks and block_seconds > 0:
        text += ", {:.1f} bloques por hora".format(blocks * 3600.0 / block_seconds)
    summary = getattr(provider, "perf_summary", None)
    share = summary().get("cache_share") if callable(summary) else None
    if share is not None:
        text += ", {:.0f} % del prompt salió de la caché del servidor".format(share * 100)
    return text


def run_block(history, cfg, block, provider_decider, *, entry_threshold, log=print):
    """Replays one block end to end. Returns ``(events, bars_in_block, closes, wakes)``; nothing is stored here."""
    practice = cfg["practice"]
    warm_from = block["start_ms"] - practice["warmup_days"] * DAY_MS
    bars = history.bars(block["product"], warm_from, block["end_ms"])
    expected = (block["end_ms"] - warm_from) // BAR_MS
    if len(bars) < expected * 0.98:
        raise TraderError("{}: faltan velas ({} de {}); ejecutá `prefetch`".format(block["block_id"], len(bars), expected))
    trader = Trader(cfg, block["product"], provider_decider, history.funding(block["product"]),
                    key=block["block_id"], entry_threshold=entry_threshold)
    events, wakes, in_block = [], 0, []
    for bar in bars:
        live = bar["bucket_start"] >= block["start_ms"]
        if live:
            in_block.append(bar)
        got = trader.feed(bar, trade=live)
        wakes += sum(1 for e in got if e["type"] == "decision")
        events += got
    events += trader.force_close("fin_de_bloque")
    annotate_outcomes(events, in_block, cfg, block["product"], trader.funding)
    return events, len(in_block), [float(b["close"]) for b in in_block], wakes


def check_identity(pdb, cfg, plan_meta):
    """A practice DB belongs to one config / seed / period: mixing would make the report meaningless."""
    stored = pdb.meta()
    for key, value in plan_meta.items():
        if key in stored and stored[key] != value:
            raise TraderError("{} se hizo con otra {} ({!r} y no {!r}): usá una base nueva".format(
                "la base", key, stored[key], value))
        if key not in stored:
            pdb.set_meta(key, value)


def run_practice(history, db_path, provider, cfg, holdout_ms, *, max_minutes=55.0, seed=None, blocks=None,
                 clock=time.monotonic, log=print, progress_calls=200, block_days=None, from_date=None, concurrent=None,
                 skip_entry_reason=None):
    """Runs the practice blocks inside ``max_minutes``. Resumable: finished blocks are skipped, a block cut by the budget
    is replayed next time with every stored call answered from the DB (no new model call).

    Returns ``{stop_reason, blocks_done, blocks_total, calls, mean_call_s}``; ``stop_reason``: ``done``, ``budget``,
    ``model_down``."""
    if not provider.health():
        raise TraderError("llama-server no responde en {}: arrancalo con el modelo local y volvé a lanzar `practice`. "
                          "Este comando no descarga ningún modelo y solo habla con 127.0.0.1.".format(
                              getattr(provider, "base_url", "el puerto local")))
    overrides = {k: v for k, v in (("concurrent_orders", concurrent), ("skip_entry_reason", skip_entry_reason))
                 if v is not None}
    if overrides:                                         # command-line override of the speed options (not identity)
        cfg = dict(cfg, runtime=dict(cfg.get("runtime") or {}, **overrides))
    seed = cfg["practice"]["seed"] if seed is None else seed
    plan, fold_cut = block_plan(cfg, holdout_ms, seed=seed, blocks=blocks, block_days=block_days, from_date=from_date)
    pdb = PracticeDB(db_path)
    try:
        check_identity(pdb, cfg, {
            "config_hash": config_hash(cfg), "seed": seed, "holdout_ms": holdout_ms, "fold_cut_ms": fold_cut,
            "block_days": block_days or cfg["practice"]["block_days"], "from": from_date or cfg["practice"]["from"],
            "practice_entry_threshold": cfg["practice_entry_threshold"]})
        pdb.set_meta("target_blocks", len(plan))
        identity = provider.identity()
        served_fn = getattr(provider, "served_model", None)
        served = served_fn() if callable(served_fn) else None
        model_ref = identity.get("model_ref") or "unknown"
        if served:
            log("practice: modelo servido por llama-server: {}".format(served))
            names = pdb.meta().get("served_models", [])
            if served not in names:
                pdb.set_meta("served_models", names + [served])
        started = clock()
        decider = LlmDecider(provider, cfg, store=pdb, clock=clock, deadline=started + max_minutes * 60.0,
                             model=served or model_ref)
        with pdb.db:
            run_id = pdb.db.execute("INSERT INTO runs(started_ms, args, model_ref, served_model) VALUES(?,?,?,?)", (
                int(time.time() * 1000), json.dumps({"max_minutes": max_minutes, "seed": seed, "blocks": len(plan)}),
                model_ref, served)).lastrowid
        def progress(d):
            left = max(0.0, started + max_minutes * 60.0 - clock())
            log("progreso: {} llamadas nuevas, {:.2f} s por llamada, {} transcurridos, quedan {} de presupuesto "
                "(~{} llamadas)".format(d.calls, d.mean_call(), _eta(clock() - started), _eta(left),
                                        int(left / d.mean_call()) if d.mean_call() else 0))

        decider.progress = progress
        decider.progress_every_s = 20.0
        done = pdb.done_blocks()
        pending = [b for b in plan if b["block_id"] not in done]
        log("practice: {} bloques en el plan ({} ya hechos, {} pendientes), presupuesto {} min, hasta {}, modelo {}".format(
            len(plan), len(plan) - len(pending), len(pending), max_minutes, stamp(holdout_ms), served or model_ref))
        reason, finished_here, block_seconds = "done", 0, []
        if pending:
            log("practice: preguntando a Qwen… (Ctrl+C para cortar; se retoma donde quedó)")
        for block in pending:
            t0 = clock()
            calls0 = decider.calls
            try:
                events, nbars, closes, wakes = run_block(history, cfg, block, decider,
                                                         entry_threshold=cfg["practice_entry_threshold"], log=log)
            except BudgetExhausted:
                reason = "budget"
                break
            except ModelDown:
                reason = "model_down"
                log("llama-server no contestó tres veces seguidas: se corta; lo hecho queda guardado")
                break
            pdb.commit_block(block, events, {"prompt_version": cfg["prompt"]["version"], "model": served or model_ref},
                             {"bars": nbars, "wakes": wakes, "seconds": clock() - t0}, closes)
            finished_here += 1
            block_seconds.append(clock() - t0)
            done.add(block["block_id"])
            trades = sum(1 for e in events if e["type"] == "trade")
            left = len(plan) - len(done)
            mean_block = sum(block_seconds) / len(block_seconds)
            log("bloque {}/{} {} [{}]: {} despertares, {} llamadas nuevas, {} operaciones, {:.0f} s; llamadas totales {}; "
                "ETA del plan {} (quedan {} bloques)".format(
                    len(done), len(plan), block["block_id"], block["fold"], wakes, decider.calls - calls0, trades,
                    clock() - t0, decider.calls, _eta(mean_block * left), left))
        mean_call = decider.mean_call() or None
        with pdb.db:
            pdb.db.execute("UPDATE runs SET ended_ms=?, calls=?, mean_call_s=?, stop_reason=? WHERE id=?",
                           (int(time.time() * 1000), decider.calls, mean_call, reason, run_id))
        trades = [dict(r) for r in pdb.db.execute("SELECT * FROM trades WHERE fold='calibration'")]
        if trades:
            pdb.set_meta("threshold_selection", select_threshold(trades, cfg))
        log("practice terminado ({}): {} llamadas nuevas, {} de {} bloques hechos en {}".format(
            reason, decider.calls, len(done), len(plan), _eta(clock() - started)))
        log(throughput_line(decider, provider, clock() - started, finished_here, sum(block_seconds)))
        return {"stop_reason": reason, "blocks_done": len(done), "blocks_total": len(plan), "calls": decider.calls,
                "mean_call_s": mean_call, "finished_here": finished_here}
    finally:
        pdb.close()


# --------------------------------------------------------------------------- export


def exit_labels(product, snapshot, t_ms, net_now, block, trade, funding, notional):
    """Learning label of one MANTENER / CERRAR decision: what closing now gives against holding, from the candles stored
    with the block. ``hold_*``: net bp (after costs, funding included when known) if the position were kept to +1 h, +4 h
    and the block end and closed there; ``None`` when that moment is past the block end. A forced close
    (v1 stop / 24 h limit) that comes first is used as it happened. ``best_*`` says which choice was the better one."""
    closes, start, end = block["closes"], block["start_ms"], block["end_ms"]

    def at(moment):
        index = (moment - start) // BAR_MS - 1
        if moment <= start or moment > end or index >= len(closes) or index < 0:
            return None
        position = Position(side=snapshot["side"], entry_ms=snapshot["entry_ms"], entry_px=D(snapshot["entry_px"]),
                            qty=D(snapshot["qty"]))
        return round(settle(product, position, closes[index], "strategy_exit", moment, funding, notional)["net_bp"], 2)

    forced = trade is not None and trade["closed_by"] in ("stop", "tiempo")
    out = {"close_now_net_bp": None if net_now is None else round(net_now, 2)}
    for name, moment in (("1h", t_ms + HOUR_MS), ("4h", t_ms + 4 * HOUR_MS), ("block_end", end)):
        if forced and trade["exit_ms"] <= moment:
            value, how = round(trade["net_bp"], 2), "closed_" + trade["closed_by"]
        else:
            value, how = at(moment), "marked"
        out["hold_" + name + "_net_bp"] = value
        out["hold_" + name + "_how"] = how if value is not None else None
        gain = None if value is None or net_now is None else round(value - net_now, 2)
        out["hold_better_" + name + "_bp"] = gain
        out["best_" + name] = None if gain is None else ("MANTENER" if gain >= 0 else "CERRAR")
    return out


def export_dataset(db_path, out_path, cfg=None, cache_dir=None):
    """One JSON line per decision: the STATE exactly as prompted, the answer, the guardrail info and the outcome.

    ``source`` is ``practice`` here (``live`` once the live process writes the same rows). The lines are ordered by block
    and sequence, so the file is reproducible. Returns the number of lines."""
    cfg = cfg or load_config()
    pdb = PracticeDB(db_path, readonly=True)
    try:
        meta = pdb.meta()
        trades = {(r["block_id"], r["trade_no"]): dict(r) for r in pdb.db.execute("SELECT * FROM trades")}
        blocks = {}
        for b in pdb.db.execute("SELECT block_id, start_ms, end_ms, closes FROM blocks WHERE status='done'"):
            closes = array.array("d")
            closes.frombytes(b["closes"] or b"")
            blocks[b["block_id"]] = {"start_ms": b["start_ms"], "end_ms": b["end_ms"], "closes": list(closes)}
        funding, notional = {}, D(cfg["notional_usd"])
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        count = 0
        with open(out_path, "w", encoding="utf-8") as out:
            for r in pdb.db.execute("SELECT * FROM decisions ORDER BY block_id, seq"):
                trade = trades.get((r["block_id"], r["trade_no"])) if r["trade_no"] else None
                snapshot = json.loads(r["position_json"] or "null")
                label = None
                if r["kind"] == "position" and snapshot and r["block_id"] in blocks:
                    if r["product"] not in funding:
                        rows = History(cache_dir, meta["holdout_ms"], offline=True).funding(r["product"]) \
                            if cache_dir and meta.get("holdout_ms") else []
                        funding[r["product"]] = FundingLine(rows)
                    label = exit_labels(r["product"], snapshot, r["t_ms"], r["net_bp_now"], blocks[r["block_id"]],
                                        trades.get((r["block_id"], snapshot["trade_no"])), funding[r["product"]], notional)
                line = {
                    "schema": DATASET_SCHEMA, "source": "practice", "fold": r["fold"], "block_id": r["block_id"],
                    "seq": r["seq"], "product": r["product"], "t_ms": r["t_ms"], "kind": r["kind"],
                    "state_text": r["state_text"], "state_hash": r["state_hash"], "wake": json.loads(r["wake_json"] or "null"),
                    "orders": json.loads(r["orders_json"] or "null"), "probabilities": json.loads(r["probs_json"] or "null"),
                    "confidence": r["confidence"], "model_action": r["model_action"], "action": r["action"],
                    "p_action": r["p_action"], "entry_threshold": r["threshold"],
                    "guardrail": {"override": r["override"], "forced": r["kind"] == "guardrail"},
                    "reason": r["reason"], "reason_probabilities": (json.loads(r["reason_json"] or "null") or {}).get(
                        "probabilities"),
                    "position": snapshot, "net_bp_now": r["net_bp_now"], "exit_labels": label,
                    "outcome": json.loads(r["outcome_json"] or "null"),
                    "trade": None if trade is None else {k: trade[k] for k in (
                        "side", "entry_ms", "exit_ms", "net_bp", "gross_bp", "funding_bp", "closed_by", "hold_min",
                        "mfe_bp", "mae_bp")},
                    "prompt_version": r["prompt_version"], "prompt_hash": r["prompt_hash"], "model": r["model"],
                    "config_hash": meta.get("config_hash"), "latency_ms": r["latency_ms"]}
                out.write(json.dumps(line, sort_keys=True, ensure_ascii=False) + "\n")
                count += 1
        return count
    finally:
        pdb.close()


# --------------------------------------------------------------------------- CLI


def _provider(url, timeout=120.0):
    env = dict(os.environ)
    url = url or llm.llama_url(env)
    llm.check_loopback_url(url)
    return llm.LlamaCppProvider(url, llm.model_ref(env), timeout=timeout)


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p, version_default="2", versions=VERSIONS):
        p.add_argument("--version", default=version_default, choices=versions,
                       help="trader version (default %(default)s): 1 = stop + 24 h limit, 2 = only Qwen (or the block end) "
                            "closes, 2.1 = v2 with the fixed prompt text first (speed only), 3 = 2.1 plus the mirror test, "
                            "live = the rules of the live operator replayed on history; each has its own config and "
                            "practice database")
        p.add_argument("--config", default=None, help="default: the config of the version")
        p.add_argument("--db", default=None, help="practice database (default: practice.sqlite for v1, practice-v2.sqlite "
                                                  "for v2, in data/qwen-trader)")
        p.add_argument("--cache-dir", default=DEFAULT_CACHE, help="candle and funding cache (default %(default)s)")

    pf = sub.add_parser("prefetch", help="download and cache the public candles and funding of the plan's blocks")
    common(pf)
    pf.add_argument("--blocks", type=int, default=None)
    pf.add_argument("--seed", type=int, default=None)
    pr = sub.add_parser("practice", help="replay random blocks of history with the local Qwen (needs llama-server)")
    common(pr)
    pr.add_argument("--max-minutes", type=float, default=55.0)
    pr.add_argument("--llama-url", default=None, help="default http://127.0.0.1:$LLAMA_PORT (loopback only)")
    pr.add_argument("--blocks", type=int, default=None, help="blocks in the plan (default config practice.target_blocks)")
    pr.add_argument("--seed", type=int, default=None)
    pr.add_argument("--offline", action="store_true", help="use only the local cache: no Kraken request at all")
    pr.add_argument("--sequential", action="store_true", help="ask the two option orders one after the other (default: at the "
                    "same time when the config says so; llama-server needs -np 2)")
    pr.add_argument("--ask-entry-reason", action="store_true", help="also ask the (degenerate) reason of an entry")
    pr.add_argument("--check-determinism", type=int, default=None, metavar="N", help="do not run blocks: replay N stored calls, "
                    "one by one and with both orders at once, and print the largest probability difference")
    cp = sub.add_parser("compare-prompts", help="same stored decisions of --from-version asked again with the prompt of --version")
    common(cp, "2.1")
    cp.add_argument("--from-version", default="2", choices=VERSIONS)
    cp.add_argument("--n", type=int, default=200, help="decisions to ask again (half without position, half in position)")
    cp.add_argument("--llama-url", default=None)
    cp.add_argument("--out", default=os.path.join(DATA_DIR, "comparacion-prompts.md"))
    pb = sub.add_parser("probe", help="perturbation probes: ask stored decisions again changing one number at a time")
    common(pb)
    pb.add_argument("--sample", type=int, default=200, help="stored decisions to probe (seeded, stratified)")
    pb.add_argument("--seed", type=int, default=None)
    pb.add_argument("--max-minutes", type=float, default=55.0)
    pb.add_argument("--llama-url", default=None)
    pb.add_argument("--sequential", action="store_true")
    ee = sub.add_parser("exam", help="v3 or live: ask Qwen about thousands of past photos of the market (needs llama-server)")
    common(ee, "3", ("3", "live"))
    ee.add_argument("--exam-db", default=None, help="exam database (default: %s for v3, %s for live)" % (
        DEFAULT_EXAM_DB_V3, DEFAULT_EXAM_DB_LIVE))
    ee.add_argument("--max-minutes", type=float, default=55.0)
    ee.add_argument("--llama-url", default=None)
    ee.add_argument("--offline", action="store_true", help="use only the local cache: no Kraken request at all")
    ee.add_argument("--sequential", action="store_true",
                    help="ask the real and the mirrored state of a photo one after the other (default: at the same time; "
                         "llama-server needs -np 2). Also turns off the concurrent option orders of the letters question")
    ee.add_argument("--check-parallel", type=int, default=None, metavar="N",
                    help="do not run the exam: take the first N photos of --exam-db and ask the real and the mirrored state "
                         "of each one by one and then at the same time (4 calls per photo, about N x 4 x 2.5 s), and compare "
                         "the lines F1..F8, the 16 gradients and the sign of lean_num. Saves nothing. Run it with the exam "
                         "stopped: both use the two slots of the server")
    ee.add_argument("--positioning-db", default=None, metavar="PATH",
                    help="database of the positioning collector, opened read-only for row F6 of the 'ficha' variants (default: "
                         "$POSITIONING_DB_PATH or server/data/dev-live/positioning.sqlite); without it F6 says n/d")
    ee.add_argument("--variant", default=None, metavar="ID",
                    help="a variant of config/qwen-quick-variants.json (other questions). With --quick each has its own "
                         "database and state file; for the full exam pass its own --exam-db")
    ee.add_argument("--lora", default=None, metavar="ID[:SCALE]",
                    help="ask with a LoRA adapter loaded in llama-server (--lora <file> --lora-init-without-apply; LLAMA_LORA in "
                         "pnpm dev): every request carries lora=[{id, scale}] and the exam identity includes it, so pass its "
                         "own --exam-db. Without this flag no request names an adapter (the live operator never does)")
    ee.add_argument("--exam-from", default=None, metavar="YYYY-MM-DD",
                    help="first day of the photos (default: practice.from of the config). The LoRA validation uses 2025-10-16 "
                         "so that no training photo (before 2025-10-01) is in the exam. Changes the config identity")
    ee.add_argument("--quick", nargs="?", const=150, type=int, default=None, metavar="N",
                    help="quick test: only ~N photos (default 150), in its own database (exam-v3-rapida.sqlite); leaves "
                         "rapida-v3.json for the screen. Orientative: it is not the exam")
    er = sub.add_parser("exam-report", help="v3: Spanish markdown report of the exam (no model)")
    common(er, "3", ("3", "live"))
    er.add_argument("--exam-db", default=None, help="default: exam-v3.sqlite for v3, exam-live.sqlite for live")
    er.add_argument("--variant", default=None, metavar="ID", help="report of an exam run with a variant of config/qwen-quick-variants.json")
    er.add_argument("--lora", default=None, metavar="ID[:SCALE]", help="the same --lora the exam ran with")
    er.add_argument("--exam-from", default=None, metavar="YYYY-MM-DD", help="the same --exam-from the exam ran with")
    er.add_argument("--out", default=os.path.join(DATA_DIR, "informe-examen-v3.md"))
    rp = sub.add_parser("report", help="Spanish markdown report (no model)")
    common(rp, "all", PRACTICE_VERSIONS + ("all",))
    rp.add_argument("--out", default=os.path.join(DATA_DIR, "informe.md"), help="report of v1")
    rp.add_argument("--out-v2", default=os.path.join(DATA_DIR, "informe-v2.md"), help="report of v2 (with v1 vs v2)")
    rp.add_argument("--out-v21", default=os.path.join(DATA_DIR, "informe-v2.1.md"), help="report of v2.1 (with v2 vs v2.1)")
    rp.add_argument("--out-v3", default=os.path.join(DATA_DIR, "informe-v3.md"), help="report of v3 (practice with the mirror)")
    ex = sub.add_parser("export", help="learning data: one JSON line per decision")
    common(ex)
    ex.add_argument("--out", default=os.path.join(DATA_DIR, "dataset.jsonl"))
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    try:
        if args.command not in ("report",):
            config_path, default_db = version_paths(args.version)
            args.config, args.db = args.config or config_path, args.db or default_db
            print("Qwen operador: versión {} (config {}, base {})".format(args.version, args.config, args.db))
        cfg = load_config(args.config) if args.command != "report" else None
        if args.command in ("exam", "exam-report"):
            args.exam_db = args.exam_db or (DEFAULT_EXAM_DB_LIVE if args.version == "live" else DEFAULT_EXAM_DB_V3)
        if args.command in ("exam", "exam-report") and args.version == "live":
            # the same size / leverage / products the live process runs with (QWEN_LIVE_*): they are part of the config identity,
            # and the gate only counts photos asked under the identity of the live database
            from .futures_qwen_live import apply_overrides
            cfg = apply_overrides(cfg)
        if args.command in ("exam", "exam-report"):
            if getattr(args, "exam_from", None):
                cfg = dict(cfg, practice=dict(cfg["practice"], **{"from": args.exam_from}))
            if getattr(args, "lora", None):
                cfg = dict(cfg, runtime=dict(cfg.get("runtime") or {}, lora=parse_lora(args.lora)))
        holdout_ms = load_holdout_ms()
        if args.command == "compare-prompts":
            from .futures_qwen_trader_probe import compare_lines, compare_prompts
            provider = _provider(args.llama_url)
            if not provider.health():
                raise TraderError("llama-server no responde en {}".format(provider.base_url))
            old_db = version_paths(args.from_version)[1]
            text = compare_lines(compare_prompts(old_db, cfg, provider, args.n), "v" + args.from_version, "v" + args.version)
            os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text)
            print(text)
            print("escrito en {}".format(args.out))
        elif args.command == "probe":
            from .futures_qwen_trader_probe import run_probe
            run_probe(args.db, cfg, _provider(args.llama_url), sample=args.sample, seed=args.seed, max_minutes=args.max_minutes,
                      concurrency=1 if args.sequential else None)
        elif args.command == "exam-report":
            from . import futures_qwen_quick_variants as variants
            from .futures_qwen_trader_exam import build_exam_report
            text = build_exam_report(args.exam_db, variants.apply_variant(cfg, variants.get_variant(args.variant)))
            os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text)
            print("informe del examen escrito en {}".format(args.out))
        elif args.command == "exam":
            from . import futures_qwen_quick_variants as variants
            from .futures_qwen_trader_exam import run_exam
            if args.check_parallel is not None:
                from .futures_qwen_factors import check_parallel, parallel_text
                if not cfg.get("state_ficha"):
                    raise TraderError("--check-parallel solo vale para la pregunta por factores (config con state_ficha, "
                                      "como la versión 7: --config config/qwen-live-v7.json)")
                if not os.path.exists(args.exam_db):
                    raise TraderError("no existe la base del examen: {}".format(args.exam_db))
                provider = _provider(args.llama_url)
                if not provider.health():
                    raise TraderError("llama-server no responde en {}".format(provider.base_url))
                print(parallel_text(check_parallel(args.exam_db, cfg, provider, args.check_parallel,
                                                  log=lambda *a: print(*a, flush=True))))
                return 0
            variant = variants.get_variant(args.variant) if args.variant or args.quick is not None else None
            if args.version == "live" and variant is not None and variant["kind"] not in ("control", "memory", "formula"):
                raise TraderError("con --version live se pregunta lo que pregunta Qwen en vivo (variante «actual» o «memoria»): "
                                  "las otras variantes se aplican sobre la v3")
            if variant is not None and variant.get("model") is None and variant["kind"] != "formula":
                cfg = variants.apply_variant(cfg, variant)       # its own questions / state: hashed in the identity
            if args.quick is not None:                          # los niveles de exigencia llegan por entorno (solo pruebas)
                from .futures_qwen_exigencia import apply_env
                cfg = apply_env(cfg)
            if args.positioning_db:
                cfg = dict(cfg, positioning_db=os.path.abspath(args.positioning_db))
            history = History(args.cache_dir, holdout_ms, offline=args.offline)
            if not history.offline:
                for product in dict.fromkeys(list(cfg["exam"]["products"]) + list(cfg.get("state_context") or ())):
                    print("candles {}: {} a {}".format(product, cfg["practice"]["from"], stamp(holdout_ms)))
                    history.prefetch(product, date_ms(cfg["practice"]["from"]) - cfg["practice"]["warmup_days"] * DAY_MS,
                                     holdout_ms)
            if args.sequential:
                cfg = dict(cfg, runtime=dict(cfg.get("runtime") or {}, concurrent_orders=False))
            if args.quick is not None:
                from .futures_qwen_trader_exam import fail_quick, run_formula, run_quick
                base = os.path.dirname(os.path.abspath(args.exam_db))
                quick_db = os.path.join(base, variants.db_name(variant["id"]))
                state_path = os.path.join(base, variants.state_name(variant["id"]))
                if variant["kind"] == "formula":                # no Qwen: only the formulas over the stored candles
                    state = run_formula(history, cfg, holdout_ms, state_path, variant)
                    print("prueba rápida {}: {}".format(variant["id"], state["state"]))
                    return
                try:
                    server = variants.ModelServer(variant["model"]) if variant.get("model") else None
                    with server or contextlib.nullcontext():
                        url = server.url if server else args.llama_url
                        if server:
                            cfg = variants.apply_variant(cfg, variant)
                        state = run_quick(history, quick_db, _provider(url), cfg, holdout_ms,
                                          snapshots=args.quick, max_minutes=args.max_minutes, state_path=state_path,
                                          variant=variant, concurrent=not args.sequential)
                except variants.VariantError as error:
                    state = fail_quick(state_path, variant, str(error))
                print("prueba rápida {}: {}".format(variant["id"], state["state"]))
                return
            if variant is not None and variant.get("model"):
                raise TraderError("el examen completo de una variante de modelo no está soportado")
            run_exam(history, args.exam_db, _provider(args.llama_url), cfg, holdout_ms, max_minutes=args.max_minutes,
                     concurrent=not args.sequential)
        elif args.command in ("prefetch", "practice"):
            history = History(args.cache_dir, holdout_ms, offline=getattr(args, "offline", False))
            plan, _ = block_plan(cfg, holdout_ms, seed=args.seed, blocks=args.blocks)
            if args.command == "prefetch" or not history.offline:
                span = {}
                for b in plan:
                    lo, hi = span.get(b["product"], (b["start_ms"], b["end_ms"]))
                    span[b["product"]] = (min(lo, b["start_ms"]), max(hi, b["end_ms"]))
                for product, (lo, hi) in sorted(span.items()):
                    print("candles {}: {} a {}".format(product, stamp(lo), stamp(hi)))
                    history.prefetch(product, date_ms(cfg["practice"]["from"]) - cfg["practice"]["warmup_days"] * DAY_MS,
                                     hi)
            if args.command == "practice" and args.check_determinism is not None:
                from .futures_qwen_trader_probe import check_determinism, determinism_text
                provider = _provider(args.llama_url)
                if not provider.health():
                    raise TraderError("llama-server no responde en {}".format(provider.base_url))
                print(determinism_text(check_determinism(args.db, cfg, provider, args.check_determinism)))
            elif args.command == "practice":
                provider = _provider(args.llama_url)
                run_practice(history, args.db, provider, cfg, holdout_ms, max_minutes=args.max_minutes, seed=args.seed,
                             blocks=args.blocks, concurrent=False if args.sequential else None,
                             skip_entry_reason=False if args.ask_entry_reason else None)
        elif args.command == "report":
            from .futures_qwen_trader_report import build_report
            wanted = PRACTICE_VERSIONS if args.version == "all" else (args.version,)
            paths = {v: version_paths(v) for v in wanted}
            if args.db and len(wanted) == 1:
                paths[wanted[0]] = (paths[wanted[0]][0], args.db)
            base, same_state = None, None
            exists = lambda v: os.path.exists(version_paths(v)[1] if v not in paths else paths[v][1])
            if "2" in wanted and exists("1") and exists("2"):
                base = (version_paths("1")[1], load_config(version_paths("1")[0]))
            if "2.1" in wanted and exists("2") and exists("2.1"):
                same_state = (version_paths("2")[1], load_config(version_paths("2")[0]))
            written = 0
            for v in wanted:
                config_path, db = paths[v]
                if not os.path.exists(db):
                    if args.version == "all":
                        print("versión {}: no hay base ({}); se omite".format(v, db))
                        continue
                    raise TraderError("no existe la base de la versión {}: {}".format(v, db))
                text = build_report(db, load_config(args.config or config_path), args.cache_dir,
                                    baseline=base if v == "2" else None, prompt_baseline=same_state if v == "2.1" else None)
                out = {"1": args.out, "2": args.out_v2, "2.1": args.out_v21, "3": args.out_v3}[v]
                os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
                with open(out, "w", encoding="utf-8") as handle:
                    handle.write(text)
                print("informe de la versión {} escrito en {}".format(v, out))
                written += 1
            if not written:
                raise TraderError("no hay ninguna base de práctica que informar (ejecutá `practice` primero)")
        else:
            print("{} decisiones escritas en {}".format(export_dataset(args.db, args.out, cfg, args.cache_dir), args.out))
        return 0
    except KeyboardInterrupt:
        print("\ncortado con Ctrl+C: lo ya preguntado quedó guardado; volvé a lanzar el mismo comando para retomar "
              "(compare-prompts, --check-determinism y --check-parallel no guardan nada).", flush=True)
        return 130
    except (TraderError, HistoryError, ValueError) as error:
        print("error: {}".format(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
