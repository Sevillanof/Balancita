"""Issue #183 (BAL-COORD-183-PRUEBA-TARDIA-01): official candles recovered after a capture outage, with a ``known_at`` about 2.4 h
after the bucket they describe. The ingestor cases use a few hand-written rows in a capture-shaped file; the session cases use the
real BTC market of the sample, with its real candles of the outage handed over late (the only thing changed is their ``known_at``).
No real database, no network, no wall clock. The measured shape comes from BAL-RESULTADO-183-02 (the 1-minute official candles of one window were completely there
but the tail of their ``known_at - bucket end`` reached about 2.4 h: coverage is not availability).

What is shown at the ingestor (this file, ``TestLateCandlesAtTheIngestor``):

* no candle is emitted at a time earlier than the one it became known (``t_ms = max(known_at, bucket + 60 s)``), and the whole
  stream stays in time order: a recovered candle is never placed back at its bucket;
* the recovered candles are held until the tickers prove the source is back, and while they are held the source is ``stale``:
  a candle is not a quote, it does not move ``last_any_ticker_ms``, it does not make the source ``live`` and no ``clock`` tick
  runs through the outage;
* a candle recorded after the watermark already passed its time is counted (``late_source_rows``) and not emitted: it is lost,
  never used backwards;
* a restart in the middle (checkpoint, new reader) and reading again do not duplicate any event.

What is shown together with the evaluator, the runner and the portfolio (``TestLateCandlesThroughTheSession``): see that class."""

import contextlib
import os
import shutil
import tempfile
import unittest
from unittest import mock

from balancita_engine import paper_live_ingest as ING
from balancita_engine.paper_live_ingest import Ingestor, SourceReader
import real_session as RSN
from real_session import DECIDE_FROM, STEP, abandon, journal_clock, new_session, record, recover_session
from real_world import RealWorld
from test_paper_live_ingest import BTC, CYCLE, MIN, SEC, Source

T0 = CYCLE
LIVE_MIN = 20                                   # the capture is alive for the first 20 minutes
OUTAGE_MIN = 144                                # and then silent for 2.4 h
OUTAGE_FROM = T0 + LIVE_MIN * MIN               # first minute with nothing
RESUME = OUTAGE_FROM + OUTAGE_MIN * MIN         # the capture is back: its first ticker is a few seconds after
LAST_LIVE_TICKER = T0 + LIVE_MIN * MIN - 10 * SEC
HOLE_BUCKETS = [T0 + m * MIN for m in range(LIVE_MIN, LIVE_MIN + OUTAGE_MIN)]


class Timeline(object):
    """The synthetic capture and one ingestor reading it poll by poll."""

    def __init__(self, directory, name="market.sqlite"):
        self.path = os.path.join(directory, name)
        self.src = Source(self.path)
        for k in range(0, LIVE_MIN * MIN, 10 * SEC):
            self.src.ticker(BTC, T0 + k, "100000")
        for m in range(LIVE_MIN):
            self.src.candle(BTC, T0 + m * MIN, 1, 2, 1, 2)
        self.src.commit()
        self.reader = SourceReader(self.path)
        self.ing = Ingestor(self.reader, expected_products=(BTC,))
        self.events = []
        self.last_state = None

    def poll(self, now):
        out = self.ing.poll(now)
        while out["state"]["more_to_read"]:
            self.events.extend(out["events"])
            out = self.ing.poll(now)
        self.events.extend(out["events"])
        self.last_state = out["state"]
        return out

    def run_to(self, end_ms, step=30 * SEC, start=None):
        now = T0 if start is None else start
        while now <= end_ms:
            self.poll(now)
            now += step

    def live_part(self):
        self.run_to(T0 + (LIVE_MIN + 3) * MIN)

    def through_the_outage(self):
        for now in (OUTAGE_FROM + 30 * MIN, OUTAGE_FROM + 100 * MIN, RESUME - SEC):
            self.poll(now)

    def recover_candles(self, known_at, buckets=None):
        for bucket in HOLE_BUCKETS if buckets is None else buckets:
            self.src.candle(BTC, bucket, 1, 2, 1, 2, known_at=known_at)
        self.src.commit()

    def resume_tickers(self, count=8):
        for k in range(1, count + 1):
            self.src.ticker(BTC, RESUME + 10 * SEC * k, "100000")
        self.src.commit()

    def candle_events(self, bucket_in=None):
        return [e for e in self.events if e["kind"] == "candle" and (bucket_in is None or e["payload"]["bucket_ms"] in bucket_in)]

    def close(self):
        self.reader.close()
        self.src.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.tl = Timeline(self.dir)
        self.addCleanup(self.tl.close)

    def outage_with_candles_recovered(self, known_at):
        """The capture was down for 2.4 h; the official candles of those minutes are recorded afterwards (one batch, ``known_at``)."""
        self.tl.live_part()
        self.tl.through_the_outage()
        self.tl.recover_candles(known_at)


class TestLateCandlesAtTheIngestor(Base):
    KNOWN = RESUME + 5 * SEC

    def test_a_recovered_candle_enters_the_stream_when_it_is_known_not_at_its_bucket(self):
        self.outage_with_candles_recovered(self.KNOWN)
        self.tl.resume_tickers()
        self.tl.poll(RESUME + 80 * SEC)
        events = self.tl.candle_events(HOLE_BUCKETS)
        self.assertEqual(len(events), OUTAGE_MIN)                                    # every recovered candle is delivered once
        self.assertEqual({e["t_ms"] for e in events}, {self.KNOWN})                  # all at the instant they became known
        delays = []
        for event in events:
            bucket = event["payload"]["bucket_ms"]
            self.assertGreaterEqual(event["t_ms"], self.KNOWN)                       # never before it was known
            delays.append(event["t_ms"] - (bucket + MIN))                            # how long after its own close it enters the stream
        self.assertTrue(all(delay >= 5 * SEC for delay in delays))                   # none is stamped at its own close
        self.assertGreaterEqual(max(delays), 143 * MIN)                              # the oldest one entered about 2.4 h after it closed

    def test_the_stream_keeps_its_time_order_and_the_recovered_candles_come_before_the_first_quote_back(self):
        self.outage_with_candles_recovered(self.KNOWN)
        self.tl.resume_tickers()
        self.tl.poll(RESUME + 80 * SEC)
        times = [e["t_ms"] for e in self.tl.events]
        self.assertEqual(times, sorted(times))                                       # nothing is ever placed back in time
        first_back = min(e["t_ms"] for e in self.tl.events if e["kind"] == "quote" and e["t_ms"] > OUTAGE_FROM)
        self.assertEqual(first_back, RESUME + 10 * SEC)
        self.assertLess(self.KNOWN, first_back)

    def test_recovered_candles_alone_do_not_make_the_source_alive_nor_refresh_the_quote(self):
        """The capture is still silent (no ticker): the candles are recorded, and they change nothing about the quote."""
        self.outage_with_candles_recovered(self.KNOWN)
        quotes_before = len([e for e in self.tl.events if e["kind"] == "quote"])
        out = self.tl.poll(RESUME + SEC)
        self.assertEqual(out["state"]["source"], "stale")                            # no ticker advanced: the source is still stale
        self.assertEqual(self.tl.ing.last_any_ticker_ms, LAST_LIVE_TICKER)           # a candle is not a quote
        self.assertEqual(self.tl.ing.last_ticker_ms[BTC], LAST_LIVE_TICKER)
        self.assertEqual(len([e for e in self.tl.events if e["kind"] == "quote"]), quotes_before)
        self.assertEqual(self.tl.candle_events(HOLE_BUCKETS), [])                    # still held: the tickers have not proved the return
        self.assertEqual(out["state"]["pending"], OUTAGE_MIN)
        alive_until = LAST_LIVE_TICKER + self.tl.ing.dead_after_ms
        clocks = [e["t_ms"] for e in self.tl.events if e["kind"] == "clock"]
        self.assertLessEqual(max(clocks), alive_until)                               # no clock tick through the outage

    def test_the_outage_is_recorded_as_evidence_and_the_first_quote_back_closes_it(self):
        self.outage_with_candles_recovered(self.KNOWN)
        self.tl.resume_tickers()
        out = self.tl.poll(RESUME + 80 * SEC)
        self.assertEqual(out["state"]["source"], "live")
        self.assertEqual([(o["from_ms"], o["to_ms"]) for o in out["state"]["outages"]], [(LAST_LIVE_TICKER, RESUME + 10 * SEC)])
        self.assertEqual(out["state"]["silences"]["source"], 1)

    def test_candles_recovered_in_batches_enter_each_at_its_own_instant(self):
        self.tl.live_part()
        self.tl.through_the_outage()
        thirds = [HOLE_BUCKETS[i:i + 48] for i in (0, 48, 96)]
        instants = [RESUME + 5 * SEC, RESUME + 25 * SEC, RESUME + 45 * SEC]
        self.tl.resume_tickers(count=8)
        for batch, known_at in zip(thirds, instants):
            self.tl.recover_candles(known_at, batch)
        self.tl.poll(RESUME + 120 * SEC)
        by_bucket = {e["payload"]["bucket_ms"]: e["t_ms"] for e in self.tl.candle_events(HOLE_BUCKETS)}
        self.assertEqual(len(by_bucket), OUTAGE_MIN)
        for batch, known_at in zip(thirds, instants):
            self.assertEqual({by_bucket[b] for b in batch}, {known_at})              # each at the instant its batch was recorded
        times = [e["t_ms"] for e in self.tl.events]
        self.assertEqual(times, sorted(times))

    def test_a_candle_recorded_after_its_time_was_released_is_counted_and_lost_never_used_backwards(self):
        """Clock skew or a wrong ``known_at``: the tickers already moved past the instant the batch says it was known. The ingestor
        refuses to emit it (the runner would reject it as out of order) and keeps the evidence."""
        self.tl.live_part()
        self.tl.through_the_outage()
        self.tl.resume_tickers(count=8)
        self.tl.poll(RESUME + 80 * SEC)                                                # the tickers are back and released
        before = len(self.tl.events)
        self.tl.recover_candles(RESUME + 5 * SEC)                                      # claims it was known before the quotes released
        out = self.tl.poll(RESUME + 90 * SEC)
        self.assertEqual(len(self.tl.events), before)                                  # nothing is emitted for them
        self.assertEqual(self.tl.candle_events(HOLE_BUCKETS), [])
        self.assertEqual(out["state"]["stats"]["late_source_rows"], OUTAGE_MIN)
        self.assertEqual(len(out["state"]["late_sample"]), 20)                         # the sample is capped, the count is exact

    def test_a_restart_in_the_middle_and_reading_again_do_not_duplicate_any_event(self):
        self.outage_with_candles_recovered(self.KNOWN)
        self.tl.resume_tickers()
        self.tl.poll(RESUME + 80 * SEC)
        reference = [e["event_id"] for e in self.tl.events]
        self.assertEqual(len(reference), len(set(reference)))
        self.tl.poll(RESUME + 90 * SEC)                                                # reading an exhausted source again
        self.assertEqual([e["event_id"] for e in self.tl.events], reference)
        # the same timeline, killed after the recovered candles were read but while they were still held
        other_dir = os.path.join(self.dir, "other")
        os.makedirs(other_dir)
        other = Timeline(other_dir)
        self.addCleanup(other.close)
        other.live_part()
        other.through_the_outage()
        other.recover_candles(self.KNOWN)
        other.poll(RESUME + SEC)
        self.assertEqual(other.last_state["pending"], OUTAGE_MIN)                      # read, held, not emitted
        state = other.ing.checkpoint()
        emitted_before = [e["event_id"] for e in other.events]
        other.reader.close()
        other.reader = SourceReader(other.path)
        other.ing = Ingestor.from_checkpoint(other.reader, state, expected_products=(BTC,))
        other.resume_tickers()
        other.poll(RESUME + 80 * SEC)
        resumed = [e["event_id"] for e in other.events]
        self.assertEqual(resumed, reference)                                           # same stream as the uninterrupted run
        self.assertEqual(len(resumed), len(set(resumed)))
        self.assertEqual(resumed[:len(emitted_before)], emitted_before)


HOLE_FROM = DECIDE_FROM + 40 * MIN                 # the capture goes down 40 minutes into the decision window (the evaluator has caught up by then)
BUY_AT = (DECIDE_FROM + 60 * MIN,)                 # the one forced entry, inside the outage
HOLE_TO = HOLE_FROM + 144 * MIN                    # and is back 2.4 h later
KNOWN_BACK = HOLE_TO                              # the recovered 1-minute official candles are known as the tickers come back (the same batch)


class LateWorld(RealWorld):
    """The real BTC market, but the 1-minute candles of the outage are not in the file while it lasts: the real rows are handed over
    in one batch (``known_at = KNOWN_BACK``) when the tickers are back, the late shape of BAL-RESULTADO-183-02. ``recover=False`` is
    the control: the same outage and no recovery at all."""

    def __init__(self, directory, recover=True):
        super().__init__(directory, quote_holes=[(HOLE_FROM, HOLE_TO)])
        rows = []
        for row in self.candle_rows:
            if HOLE_FROM <= row["bucket_start"] < HOLE_TO:
                if not recover:
                    continue
                row = dict(row, known_at=KNOWN_BACK)
            rows.append(row)
        self.candle_rows = sorted(rows, key=lambda r: (r["known_at"], r["bucket_start"]))


_real_candle_event = ING._candle_event


def naive_candle_event(row):
    """What the ingestor would do if it ignored ``known_at``: the candle enters at the close of its own minute."""
    return _real_candle_event(dict(row, known_at=0))


def instants():
    out = [DECIDE_FROM + k * STEP for k in range(8)]                               # the real history is read 5000 rows a step: 7 steps to catch up
    t = HOLE_FROM - 10 * MIN
    while t < HOLE_TO + 60 * MIN:
        t += 10 * MIN
        out.append(t)
    out += [HOLE_TO + 4 * SEC, HOLE_TO + 6 * SEC, HOLE_TO + 20 * SEC]
    return sorted(set(out))


class TestLateCandlesThroughTheSession(unittest.TestCase):
    """Evaluator, runner and portfolio behind the ingestor, over the same 2.4 h outage. Candles are the only thing the late data
    brings; nothing here changes a threshold or a policy."""

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp()
        cls.buckets = BUY_AT
        strategies = cls.strategies = RSN.strategies(cls.buckets)
        cls.runs = {}
        for name, recover, naive in (("late", True, False), ("control", False, False), ("naive", True, True)):
            os.makedirs(os.path.join(cls.root, "w-" + name))
            world = LateWorld(os.path.join(cls.root, "w-" + name), recover=recover)
            world.release_until(DECIDE_FROM - MIN)
            directory = os.path.join(cls.root, "s-" + name)
            # "naive" is the counterfactual: the same recovered candles stamped at the close of their own bucket (known_at ignored)
            with mock.patch.object(ING, "_candle_event", naive_candle_event) if naive else contextlib.nullcontext():
                session = new_session(world, directory, strategies)
                for now in instants():
                    world.release_until(now)
                    session.step(now)
            cls.runs[name] = (world, directory, session)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, True)

    def test_every_candle_that_enters_the_runner_does_it_at_or_after_it_was_known(self):
        session = self.runs["late"][2]
        accepted = [e["data"]["event"] for e in session.runner.journal.entries
                    if e["kind"] == "event_accepted" and e["data"]["event"]["kind"] == "candle"
                    and HOLE_FROM <= e["data"]["event"]["payload"]["bucket_ms"] < HOLE_TO]
        self.assertTrue(accepted)
        self.assertEqual({e["t_ms"] for e in accepted}, {KNOWN_BACK})                # at the instant they were known, never at the bucket
        times = [e["t_ms"] for e in session.runner.journal.entries if e["kind"] == "event_accepted"]
        self.assertEqual(times, sorted(times))

    def test_the_old_recovered_candles_are_rejected_as_late_not_applied_backwards(self):
        session = self.runs["late"][2]
        rejected = [e["data"] for e in session.runner.journal.entries if e["kind"] == "event_rejected" and e["data"]["kind"] == "candle"]
        accepted = [e for e in session.runner.journal.entries if e["kind"] == "event_accepted" and e["data"]["event"]["kind"] == "candle"
                    and HOLE_FROM <= e["data"]["event"]["payload"]["bucket_ms"] < HOLE_TO]
        self.assertEqual({r["reason"] for r in rejected}, {"late_candle"})
        self.assertEqual(len(rejected) + len(accepted), 144)                         # every recovered candle has exactly one fate
        self.assertGreater(len(rejected), len(accepted))                             # most of the old ones are too late for the runner

    def test_the_recovery_changes_no_decision_no_order_and_no_money_against_the_control_without_recovery(self):
        late, control = self.runs["late"][2], self.runs["control"][2]
        a, b = record(late, 0), record(control, 0)
        self.assertEqual(a, b)                                                        # signals, orders, portfolio, fees: identical
        self.assertEqual([o["state"] for o in late.runner.orders()], [o["state"] for o in control.runner.orders()])
        cycles = lambda s: [e["data"]["event"]["t_ms"] for e in s.runner.journal.entries
                            if e["kind"] == "event_accepted" and e["data"]["event"]["kind"] == "cycle"]
        self.assertEqual(cycles(late), cycles(control))                              # no decision cycle is added or moved by the late data

    def test_the_case_has_a_concrete_opportunity_that_ignoring_known_at_would_have_executed(self):
        """Equal empty orders would prove little. The counterfactual run (known_at ignored) makes retroactive decisions inside the
        outage and the order book changes: the protection is what keeps them out of the real run."""
        late, control, naive = (self.runs[k][2] for k in ("late", "control", "naive"))
        decisions = lambda s: len([e for e in s.runner.journal.entries if e["kind"] == "decision"])
        self.assertEqual(decisions(late), decisions(control))
        self.assertGreater(decisions(naive), decisions(control))                      # decisions on candles of minutes already over
        self.assertGreater(len(naive.runner.orders()), len(control.runner.orders()))   # and orders that the real run never has
        self.assertEqual(len(late.runner.orders()), len(control.runner.orders()))
        self.assertNotEqual(record(naive, 0)["orders"], record(control, 0)["orders"])

    def test_a_late_candle_does_not_refresh_the_quote(self):
        late, control = self.runs["late"][2], self.runs["control"][2]
        self.assertEqual(late.runner.quote_t_ms, control.runner.quote_t_ms)

    def test_a_simulated_death_after_the_recovery_does_not_repeat_any_effect(self):
        """What runs: the session is abandoned between steps (runner, reader and funding closed without a stop, only the lock goes)
        and recovered from disk at the same instant. It is a simulated death at a step boundary, not a SIGKILL of a process."""
        world, directory, session = self.runs["late"]
        before = record(session, 0)
        events_before = len(session.runner.journal.entries)
        now = HOLE_TO + 20 * SEC
        abandon(session)                                                              # the process dies: the lock goes with it
        recovered = recover_session(world, directory, self.strategies, max(now, journal_clock(directory)))
        recovered.step(now + SEC)
        after = record(recovered, 0)
        for key in ("financial", "signals", "orders", "portfolio", "closed", "open", "fees", "funding_usd", "accounting_orders"):
            self.assertEqual(after[key], before[key], key)
        self.assertGreaterEqual(len(recovered.runner.journal.entries), events_before)
        ids = [e["data"]["event"]["event_id"] for e in recovered.runner.journal.entries if e["kind"] == "event_accepted"]
        self.assertEqual(len(ids), len(set(ids)))                                    # the same recovered candle is never accepted twice


if __name__ == "__main__":
    unittest.main()
