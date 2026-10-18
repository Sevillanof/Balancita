"""The session harness on the real market (``real_world``): a clock that moves in five-minute steps from the first decision, the
configuration of a paper process on real BTC candles and quotes, and the frozen strategies with one hand-written exception, ``Forcing``.

The frozen strategies see no entry in the 17 hours of the real sample, so a test that needs an open position says in two lines at which
5-minute buckets C29 buys; every other decision, and the whole market, are the real ones. Nothing here is generated."""

import json
import os
import shutil
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import paper_live_process as LP
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from balancita_engine.multi_signals import Strategy
from real_world import BTC, MIN, SEC, T0, RealWorld

STEP = 5 * MIN
DECIDE_FROM = T0 + 270 * MIN                    # the evaluator's first decision comes about 130 minutes of 5-minute bars later
DECIDE_UNTIL = T0 + 1100 * MIN
BUY_AT = (T0 + 300 * MIN, T0 + 420 * MIN)       # the 5-minute buckets where the forced entries are
MAX_QUOTE_GAP_MS = 25 * SEC                     # above the longest real silence of the sample (3.7 s)
INGEST_KW = {"clock_every_ms": 10 ** 12}
D = Decimal


class Forcing(Strategy):
    """A frozen strategy that buys at the named buckets and decides as itself everywhere else."""

    def __init__(self, inner, buckets):
        self.__dict__.update(inner.__dict__)
        self.inner, self.buckets = inner, set(buckets)

    def decide(self, ctx):
        if ctx.bucket_ms in self.buckets:
            return "BUY", D("0.8"), {"forced": "by the test"}, "forced entry"
        return self.inner.decide(ctx)


def strategies(buckets=BUY_AT):
    return [Forcing(s, buckets) if s.id.startswith("c29") else s for s in RS.load_frozen()[0]]


def config_dict(**over):
    body = {"schema": LP.CONFIG_SCHEMA, "products": [BTC], "decide_from_ms": DECIDE_FROM, "decide_until_ms": DECIDE_UNTIL,
            "ingest_kw": INGEST_KW, "max_quote_gap_ms": MAX_QUOTE_GAP_MS, "min_free_bytes": 1, "warmup_minutes": 100,
            "funding_mode": "observed", "source_id": "synthetic"}      # a replay of real rows through the fixture seam: the real source is not authorized
    body.update(over)
    return body


class Clock(object):
    """``now`` is the instant of step ``index`` from the first decision; ``sleep`` moves to the next one."""

    def __init__(self, start=0):
        self.index = start

    def now(self):
        return DECIDE_FROM + self.index * STEP

    def sleep(self, _seconds):
        self.index += 1


def position_detail(supervisor):
    """Everything that identifies an open position and its protection, as the runner holds it (not a count)."""
    rows = []
    for product, book in sorted(supervisor.session.runner.portfolio.positions.items()):
        pos = book.position
        rows.append((product, book.intent["intent_id"], pos["side"], int(pos["entry_ms"]), str(pos["entry"]), str(pos["stop"]),
                     str(pos["target"]), str(pos["quantity"])))
    return rows


class Base(unittest.TestCase):
    """A real world released up to the minute before the first decision, a session directory, and ``supervisor`` to build processes on it."""

    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache["dir"] = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def setUp(self):
        self.root = tempfile.mkdtemp(dir=self.cache["dir"])
        self.world = RealWorld(self.root)
        self.world.release_until(DECIDE_FROM - MIN)
        self.directory = os.path.join(self.root, "session")
        self.supervisors = []

    def tearDown(self):
        for supervisor in self.supervisors:
            if supervisor.session is not None:
                supervisor.abandon()
        self.world.close()

    def supervisor(self, clock, world=None, directory=None, **over):
        config = LP.validate_config(config_dict(**over))
        world = world or self.world
        supervisor = LP.Supervisor(config, directory or self.directory, world.path, clock=clock.now, sleep=clock.sleep,
                                   tick=world.release_until, strategies=strategies())
        self.supervisors.append(supervisor)
        return supervisor

    def read(self, name):
        with open(os.path.join(self.directory, name), encoding="utf-8") as handle:
            return json.load(handle)
