"""Qwen's own track record, as input for its next decision.

The question stays what it always was (buy, hold or sell, scored +1 / -1 by
``futures_llm_scores``). What can improve is the judgement, so the STATE of a
decision may carry ``lessons``: the model's last decisions that are already
judged, each with what it saw, what it chose and which action was right.

No information from the future reaches a decision. A decision taken at bucket
``b`` is judged by the close ``HORIZON_MIN`` minutes later (bucket
``b + HORIZON_MIN``), so it appears in the lessons of a decision at bucket ``n``
only when ``b + HORIZON_MIN <= n``, which is when that close exists.

The right action uses the scorer's own rule and costs: ``buy`` if the long net
return after the round-trip cost is positive, ``sell`` if the short one is,
otherwise ``hold`` (the move did not clear the cost).
"""

import collections
import re
from decimal import Decimal

from .futures_costs import DEFAULT_PRODUCT, round_trip_cost_bps
from .futures_hits import trade_hit
from .futures_llm_scores import ACTIONS, HORIZON_MIN
from .futures_verdicts import ONE_MINUTE_MS

WINDOW = 60  # judged decisions the summary covers
EXAMPLES = 8  # most recent ones listed one by one
MAX_AGE_MS = 2 * 24 * 60 * ONE_MINUTE_MS  # older decisions and closes are forgotten
TEN_THOUSAND = Decimal(10_000)
_LINE = re.compile(r"^(regime|strategy_consensus): (.*)$", re.MULTILINE)


def right_action(entry_close, exit_close, product_id=DEFAULT_PRODUCT):
    """The action that would have scored +1, by the same rule as ``futures_llm_scores.score_decisions``."""
    entry, exit_price = Decimal(str(entry_close)), Decimal(str(exit_close))
    cost = round_trip_cost_bps(product_id)
    gross = (exit_price - entry) / entry * TEN_THOUSAND
    if trade_hit(gross - cost):
        return "buy"
    if trade_hit(-gross - cost):
        return "sell"
    return "hold"


def summarize_state(state_text):
    """What the model saw, in a short normalized phrase (regime and strategy consensus)."""
    seen = dict(_LINE.findall(state_text or ""))
    consensus = seen.get("strategy_consensus", "n/a").replace("buy=", "b").replace("hold=", "h").replace("sell=", "s")
    return "{} {}".format(seen.get("regime", "n/a"), consensus)


def _pct(part, whole):
    return "n/a" if not whole else "{}%".format(round(100 * part / whole))


class Lessons:
    """Per product memory of decisions and closes; ``text`` renders the lessons known at a bucket."""

    def __init__(self, product_id=DEFAULT_PRODUCT, window=WINDOW, examples=EXAMPLES):
        self.product_id, self.window, self.examples = product_id, window, examples
        self.decisions = collections.OrderedDict()  # bucket -> (chosen, summary), oldest first
        self.closes = {}
        self._inserted = 0

    def observe_close(self, bucket, close):
        self.closes[bucket] = close
        self._inserted += 1
        if self._inserted % 1000 == 0:  # amortized: forget closes nobody will read again
            cutoff = bucket - MAX_AGE_MS
            self.closes = {b: c for b, c in self.closes.items() if b >= cutoff}

    def record(self, bucket, chosen, state_text):
        self.decisions[bucket] = (chosen, summarize_state(state_text))
        cutoff = bucket - MAX_AGE_MS
        while self.decisions and next(iter(self.decisions)) < cutoff:
            self.decisions.popitem(last=False)

    def needs(self, now_bucket):
        """Buckets whose close is still unknown but is needed to judge a decision known by ``now_bucket``."""
        wanted = set()
        for bucket in self.decisions:
            if now_bucket - MAX_AGE_MS <= bucket and bucket + HORIZON_MIN * ONE_MINUTE_MS <= now_bucket:
                wanted.update((bucket, bucket + HORIZON_MIN * ONE_MINUTE_MS))
        return sorted(b for b in wanted if b not in self.closes)

    def judged(self, now_bucket):
        rows = []
        for bucket, (chosen, summary) in self.decisions.items():
            exit_bucket = bucket + HORIZON_MIN * ONE_MINUTE_MS
            if exit_bucket > now_bucket or bucket not in self.closes or exit_bucket not in self.closes:
                continue
            right = right_action(self.closes[bucket], self.closes[exit_bucket], self.product_id)
            rows.append({"bucket": bucket, "chosen": chosen, "right": right, "summary": summary,
                         "point": 1 if chosen == right else -1})
        return rows[-self.window:]

    def text(self, now_bucket):
        rows = self.judged(now_bucket)
        if not rows:
            return "lessons: none yet"
        hits = sum(1 for r in rows if r["point"] == 1)
        mine = "; ".join("{} {}".format(a, _pct(sum(1 for r in rows if r["chosen"] == a and r["point"] == 1),
                                                sum(1 for r in rows if r["chosen"] == a)))
                         for a in ACTIONS if any(r["chosen"] == a for r in rows))
        right = " ".join("{}={}".format(a, _pct(sum(1 for r in rows if r["right"] == a), len(rows))) for a in ACTIONS)
        lines = [
            "lessons: your last {} decisions, judged {} minutes later (+1 when your action was the right one)".format(
                len(rows), HORIZON_MIN),
            "lessons_score: {} right of {} ({}); correct when you chose: {}".format(
                hits, len(rows), _pct(hits, len(rows)), mine),
            "lessons_right_action: " + right,
        ]
        for r in rows[-self.examples:]:
            lines.append("lessons_example: saw {} -> chose {}, right was {} ({:+d})".format(
                r["summary"], r["chosen"], r["right"], r["point"]))
        return "\n".join(lines)


# The decision is the same in every arm: same instruction, options and +1 rule. They differ only in the
# extra context lines of the STATE, so a replay over the same candles compares them cleanly.
ARMS = ("original", "context", "learning")
_EXTRA_FIELDS = {"original": ("strategy_reliability", "lessons"), "context": ("lessons",), "learning": ()}


def question_arm(question, arm):
    """``trade_action`` as it was first defined (``original``), with strategy reliability as one more line
    of context (``context``), or as shipped, with Qwen's judged decisions too (``learning``)."""
    if arm not in ARMS:
        raise ValueError("unknown arm {!r}".format(arm))
    shipped = question["state_fields"]
    arm_question = dict(question, state_fields=[f for f in shipped if f not in _EXTRA_FIELDS[arm]])
    if arm == "original":
        arm_question.pop("order_debias", None)  # as first defined: one fixed letter order
    arm_question["version"] = {"original": 1, "context": 2}.get(arm, question["version"])
    return arm_question
