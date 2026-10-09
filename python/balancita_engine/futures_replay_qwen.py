"""Qwen deciding blind over a replay range (SS-08).

For every chosen frame it builds the same normalized STATE the live process Q
builds (no dates, no absolute prices, no product name) from candles that closed
before the decision, asks the question and records the answer. Freshness limits
of the live service do not apply. Answers are cached by prompt hash (the model
runs at a fixed temperature), so replaying a range twice asks nothing new.
"""

import collections
import hashlib
import json
import sqlite3

from .futures_llm_decisions import (
    StateError,
    default_reliability,
    ModelResponseError,
    ask_state,
    build_prompt,
    build_state,
    question_letters,
    temperature_for,
)
from .futures_costs import DEFAULT_PRODUCT
from .futures_llm_lessons import Lessons
from .futures_llm_scores import HORIZON_MIN
from .futures_spec_strategy import propose_spec
from .futures_strategy_signals import consensus, verdict_signals
from .futures_strategy_reliability import RELIABILITY_SCHEMA
from .futures_verdicts import ONE_MINUTE_MS

TRIGGERS = ("entry", "5min", "all")
WINDOW = 61  # candles the STATE fields read (returns up to 60 minutes back)
FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS


class AnswerCache:
    """Prompt-hash keyed answers; in memory, or persisted in a SQLite file shared by replays."""

    def __init__(self, path=None):
        self.db = sqlite3.connect(path or ":memory:")
        self.db.execute("CREATE TABLE IF NOT EXISTS qwen_answers(key TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        self.hits = self.misses = 0

    def get(self, key):
        row = self.db.execute("SELECT payload FROM qwen_answers WHERE key=?", (key,)).fetchone()
        if row is None:
            self.misses += 1
            return None
        self.hits += 1
        return json.loads(row[0])

    def put(self, key, value):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO qwen_answers VALUES(?,?)", (key, json.dumps(value, default=str)))

    def close(self):
        self.db.close()


def _wanted(trigger, bucket, proposals):
    if trigger == "all":
        return True
    if trigger == "5min":
        return bucket % FIVE_MINUTES_MS == 0
    return any(p.get("action") in ("LONG", "SHORT") for p in proposals)


# What a decision may believe about a strategy whose measurement does not yet exist at its time.
_NO_RELIABILITY = {"schema": RELIABILITY_SCHEMA, "strategies": {}}


def _horizons(node):
    """Every ``horizon_minutes`` a spec declares (a regime adapter has one per branch)."""
    if isinstance(node, dict):
        found = [node["horizon_minutes"]] if "horizon_minutes" in node else []
        return found + [h for v in node.values() for h in _horizons(v)]
    if isinstance(node, list):
        return [h for v in node for h in _horizons(v)]
    return []


def live_comparable(specs):
    """The specs Qwen's STATE may read in a replay: those judged on the same horizon as its own score.

    Live, Qwen only sees C25-C28 (30 minutes). C29 and C30 hold for up to 24 h, so their votes would be
    scored by a 30-minute rule they were never meant for and the replay would not match production.
    """
    return [s for s in specs if all(h <= HORIZON_MIN for h in _horizons(s))]


class BlindQwen:
    """Frame observer: collects Qwen decisions and the verdict-like rows that score them.

    The ``strategy_reliability`` line of the STATE is as of the decision: the stored table (and the forward
    summary) were measured on candles that include the replayed range, so showing them would hand the model the
    outcome. A table is used only when everything it measured closed before the decision; otherwise every
    strategy reads ``unmeasured``, as it would have on that day. ``reliability_hidden`` counts those decisions.
    """

    def __init__(self, provider, specs, question, calibration, template, *, tick_size="1",
                 trigger="entry", mode="auto", cache=None, product_id=DEFAULT_PRODUCT, reliability=None):
        if trigger not in TRIGGERS:
            raise ValueError("unknown Qwen trigger {!r}".format(trigger))
        self.provider, self.specs, self.question = provider, live_comparable(specs), question
        self.calibration, self.template, self.tick_size = calibration, template, tick_size
        self.trigger, self.mode, self.cache = trigger, mode, cache or AnswerCache()
        self.letters = question_letters(question)
        self.model_ref = provider.identity().get("model_ref") or "unknown"
        self.window = collections.deque(maxlen=WINDOW)
        # Qwen's own judged decisions, only when the question asks for them; fed with every frame's close.
        self.lessons = Lessons(product_id) if "lessons" in question["state_fields"] else None
        self.verdicts, self.decisions, self.errors = [], [], []
        self._candles = {}
        self.reliability = default_reliability() if reliability is None else reliability
        self.reliability_hidden = 0

    def _reliability_at(self, bucket):
        """The reliability table a decision at ``bucket`` could have known, else an empty one."""
        last = ((self.reliability or {}).get("period") or {}).get("last_bucket_ms")
        if last is not None and last < bucket:
            return self.reliability
        self.reliability_hidden += 1
        return _NO_RELIABILITY

    def feed_candles(self, candles_1m):
        self._candles = {c["bucket_start"]: c for c in candles_1m}

    def __call__(self, frame):
        bucket, current, previous, trend, regime = frame
        candle = self._candles[bucket]
        self.window.append(candle)
        if self.lessons is not None:
            self.lessons.observe_close(bucket, candle["close"])
        proposals = [propose_spec(s, current, previous=previous, trend=trend, regime=regime,
                                  tick_size=self.tick_size) for s in self.specs]
        verdict = {"bucket_start_ms": bucket, "decision_known_at_ms": bucket + ONE_MINUTE_MS, "regime": regime,
                   "features": {"1m": current, "5m": trend}, "proposals": proposals}
        self.verdicts.append(verdict)
        if not _wanted(self.trigger, bucket, proposals):
            return
        try:
            state = build_state(verdict, list(self.window), self.question["state_fields"],
                                {s["id"]: s for s in self.specs},
                                reliability=self._reliability_at(bucket), forward={},
                                lessons=None if self.lessons is None else self.lessons.text(bucket))
        except StateError:
            return
        answer = self._answer(state, verdict, bucket)
        if answer is None:
            return
        if self.lessons is not None:
            self.lessons.record(bucket, answer["chosen"], state)
        self.decisions.append(dict(answer, bucket_start=bucket, state_text=state))

    def _answer(self, state, verdict, bucket):
        """The decision for this STATE: cached, else asked to the model; ``None`` when the model failed."""
        prompt = build_prompt(state, self.question, self.template)
        key = hashlib.sha256("\n".join((self.model_ref, self.mode, str(self.question["version"]), prompt)).encode()).hexdigest()
        answer = self.cache.get(key)
        if answer is None:
            temperature = temperature_for(self.calibration, self.question["id"], self.question["version"])
            try:
                done = ask_state(self.provider, state, self.question, temperature, self.template, self.mode)
            except ModelResponseError as error:
                self.errors.append({"bucket_start": bucket, "kind": error.kind})
                return None
            result = done["result"]
            answer = {"chosen": result["chosen"], "probabilities": result["probabilities"],
                      "confidence": result["confidence"], "source": done["source"]}
            self.cache.put(key, answer)
        return answer


class _RuleProvider:
    """Stands in for the model of ``ConsensusRule``: nothing is ever asked."""

    def identity(self):
        return {"model_ref": "consensus-rule"}


class ConsensusRule(BlindQwen):
    """The reference arm: answers with the strategies' mean ``strategy_consensus``, no model involved.

    Same frames, same trigger, same book and same +1 rule as ``BlindQwen``, so ``futures_replay_compare`` can
    set it against Qwen's arms. The answer is the action with the largest mean probability; ties go to
    ``hold``, like a strategy that does not propose a trade.
    """

    def __init__(self, specs, question, **kwargs):
        super().__init__(_RuleProvider(), specs, question, {}, {}, **kwargs)

    def _answer(self, state, verdict, bucket):
        mean = consensus(verdict_signals(verdict, {s["id"]: s for s in self.specs})) or {"hold": 1.0}
        chosen = max(("hold", "buy", "sell"), key=lambda name: mean.get(name, 0.0))
        return {"chosen": chosen, "probabilities": {n: mean.get(n, 0.0) for n in ("buy", "hold", "sell")},
                "confidence": mean.get(chosen, 0.0), "source": "consensus"}
