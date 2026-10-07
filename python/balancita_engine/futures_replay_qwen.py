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
    ModelResponseError,
    ask_model,
    build_prompt,
    build_state,
    question_letters,
    temperature_for,
)
from .futures_spec_strategy import propose_spec
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


class BlindQwen:
    """Frame observer: collects Qwen decisions and the verdict-like rows that score them."""

    def __init__(self, provider, specs, question, calibration, template, *, tick_size="1",
                 trigger="entry", mode="auto", cache=None):
        if trigger not in TRIGGERS:
            raise ValueError("unknown Qwen trigger {!r}".format(trigger))
        self.provider, self.specs, self.question = provider, specs, question
        self.calibration, self.template, self.tick_size = calibration, template, tick_size
        self.trigger, self.mode, self.cache = trigger, mode, cache or AnswerCache()
        self.letters = question_letters(question)
        self.model_ref = provider.identity().get("model_ref") or "unknown"
        self.window = collections.deque(maxlen=WINDOW)
        self.verdicts, self.decisions, self.errors = [], [], []
        self._candles = {}

    def feed_candles(self, candles_1m):
        self._candles = {c["bucket_start"]: c for c in candles_1m}

    def __call__(self, frame):
        bucket, current, previous, trend, regime = frame
        candle = self._candles[bucket]
        self.window.append(candle)
        proposals = [propose_spec(s, current, previous=previous, trend=trend, regime=regime,
                                  tick_size=self.tick_size) for s in self.specs]
        verdict = {"bucket_start_ms": bucket, "decision_known_at_ms": bucket + ONE_MINUTE_MS, "regime": regime,
                   "features": {"1m": current, "5m": trend}, "proposals": proposals}
        self.verdicts.append(verdict)
        if not _wanted(self.trigger, bucket, proposals):
            return
        try:
            state = build_state(verdict, list(self.window), self.question["state_fields"],
                                {s["id"]: s for s in self.specs})
        except StateError:
            return
        prompt = build_prompt(state, self.question, self.template)
        key = hashlib.sha256("\n".join((self.model_ref, self.mode, str(self.question["version"]), prompt)).encode()).hexdigest()
        answer = self.cache.get(key)
        if answer is None:
            temperature = temperature_for(self.calibration, self.question["id"], self.question["version"])
            try:
                done = ask_model(self.provider, prompt, self.letters, self.question, temperature, self.template, self.mode)
            except ModelResponseError as error:
                self.errors.append({"bucket_start": bucket, "kind": error.kind})
                return
            result = done["result"]
            answer = {"chosen": result["chosen"], "probabilities": result["probabilities"],
                      "confidence": result["confidence"], "source": done["source"]}
            self.cache.put(key, answer)
        self.decisions.append(dict(answer, bucket_start=bucket, state_text=state))
