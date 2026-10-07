"""Historical replay (SS-08): every strategy decides blind over a date range of official candles.

Reads the market DB read-only and writes one self-contained run DB per replay
(summaries, trades, decisions); the live DBs are never touched. Strategies only
see candles that closed before each decision (``frames``), so the result is
deterministic for a given range and spec set.
"""

import argparse
import json
import os
import sqlite3
import sys
import threading
import time

from .futures_simulator import DEFAULT_PERIODS, Book, frames, merge_periods
from .futures_spec_strategy import DEFAULT_SPEC_DIR, declared_indicators, load_specs
from .futures_verdicts import FIVE_MINUTES_MS, ONE_MINUTE_MS, _OfficialCandles

# Enough history for the slowest indicators: the log-volatility of C29/C30 is an exponential average over
# 288 five-minute bars and needs about a week for its seed to stop mattering.
WARMUP_MS = 2000 * FIVE_MINUTES_MS
REPLAY_SCHEMA = "futures-replay.v1"

_RUN_SCHEMA = """
CREATE TABLE replay_run(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE replay_summary(strategy_id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE replay_trade(id INTEGER PRIMARY KEY, strategy_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE TABLE replay_decision(id INTEGER PRIMARY KEY, strategy_id TEXT NOT NULL, bucket_ms INTEGER NOT NULL,
  payload TEXT NOT NULL) STRICT;
"""

_QWEN_SCHEMA = """
CREATE TABLE replay_qwen_decision(id INTEGER PRIMARY KEY, bucket_ms INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE TABLE replay_qwen_report(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL) STRICT;
"""


def load_range(market_db_path, product_id, start_ms, end_ms):
    """Official 1m and 5m candles (first-known revision) from ``start_ms - warmup`` to ``end_ms``."""
    market = _OfficialCandles(market_db_path)
    try:
        if not market.available:
            raise ValueError("market DB has no per-product official candles")
        lo, cutoff = max(0, start_ms - WARMUP_MS), 2 ** 62
        rows = {}
        for interval in (ONE_MINUTE_MS, FIVE_MINUTES_MS):
            rows[interval] = market._candles(market.db.execute(
                market._ROWS_SQL.format(market._WINDOW_WHERE), (product_id, interval, lo, end_ms, cutoff)
            ).fetchall())
        return rows[ONE_MINUTE_MS], rows[FIVE_MINUTES_MS]
    finally:
        market.db.close()


def replay(specs, candles_1m, candles_5m, *, start_ms, product_id, tick_size="1", notional_usd="100",
           observers=()):
    """Books of every spec; warm-up candles feed indicators but never open positions.

    ``observers`` are called with every frame inside the range (and the warm-up ones are
    never shown to them), e.g. the blind Qwen replay.
    """
    books = [Book(spec, product_id=product_id, tick_size=tick_size, notional_usd=notional_usd) for spec in specs]
    periods = merge_periods(DEFAULT_PERIODS, *(declared_indicators(spec) for spec in specs))
    for frame in frames(candles_1m, candles_5m, periods):
        if frame[0] < start_ms:
            continue
        for book in books:
            book.on_frame(*frame)
        for observer in observers:
            observer(frame)
    return books


def write_run(path, meta, books, qwen=None):
    if os.path.exists(path):
        raise FileExistsError("replay run already exists: " + path)
    final, path = path, path + ".partial"  # readers only ever see a finished run
    db = sqlite3.connect(path)
    try:
        db.executescript(_RUN_SCHEMA)
        db.executemany("INSERT INTO replay_run VALUES(?,?)", [(k, json.dumps(v)) for k, v in meta.items()])
        for book in books:
            sid = book.spec["id"]
            db.execute("INSERT INTO replay_summary VALUES(?,?)", (sid, json.dumps(book.summary())))
            db.executemany("INSERT INTO replay_trade(strategy_id, payload) VALUES(?,?)",
                           [(sid, json.dumps(t)) for t in book.trades])
            db.executemany("INSERT INTO replay_decision(strategy_id, bucket_ms, payload) VALUES(?,?,?)",
                           [(sid, d["bucket_ms"], json.dumps(d)) for d in book.decisions])
        if qwen is not None:
            db.executescript(_QWEN_SCHEMA)
            db.executemany("INSERT INTO replay_qwen_decision(bucket_ms, payload) VALUES(?,?)",
                           [(d["bucket_start"], json.dumps(d, default=str)) for d in qwen["decisions"]])
            db.execute("INSERT INTO replay_qwen_report VALUES(1,?)", (json.dumps(qwen["report"], default=str),))
        db.commit()
    finally:
        db.close()
    os.replace(path, final)


def qwen_report(blind):
    """Points per decision and the trading book of Qwen's answers, as the live scorer computes them."""
    from .futures_llm_scores import report

    result = report(blind.decisions, blind.verdicts)
    return {key: result[key] for key in ("horizon_min", "decisions", "by_option", "trading", "skipped")}


def run(market_db, out_path, product_id, start_ms, end_ms, specs, tick_size="1", qwen=None):
    """``qwen`` is an optional ``BlindQwen``; its decisions and scores go in the same run DB."""
    if end_ms <= start_ms:
        raise ValueError("replay range is empty")
    ones, fives = load_range(market_db, product_id, start_ms, end_ms)
    if not any(c["bucket_start"] >= start_ms for c in ones):
        raise ValueError("no official candles in the requested range")
    observers = ()
    if qwen is not None:
        qwen.feed_candles(ones)
        observers = (qwen,)
    books = replay(specs, ones, fives, start_ms=start_ms, product_id=product_id, tick_size=tick_size,
                   observers=observers)
    meta = {
        "schema": REPLAY_SCHEMA, "product_id": product_id, "start_ms": start_ms, "end_ms": end_ms,
        "strategies": [s["id"] for s in specs], "candles_1m": len(ones), "created_ms": int(time.time() * 1000),
    }
    extra = None
    if qwen is not None:
        meta["qwen"] = {"question": qwen.question["id"], "version": qwen.question["version"], "trigger": qwen.trigger,
                        "model_ref": qwen.model_ref, "asked": qwen.cache.misses, "cached": qwen.cache.hits}
        extra = {"decisions": qwen.decisions, "report": qwen_report(qwen)}
    write_run(out_path, meta, books, extra)
    return [book.summary() for book in books]


class ReplayJobs:
    """Replays started from the API: one thread per run, one run DB per replay in ``directory``."""

    def __init__(self, market_db, directory, specs_provider, products, qwen_factory=None, clock=time.time):
        self.market_db, self.directory = market_db, directory
        self.specs_provider, self.products = specs_provider, products
        self.qwen_factory, self.clock = qwen_factory, clock
        self._jobs, self._lock = {}, threading.Lock()
        os.makedirs(directory, exist_ok=True)

    def start(self, product_id, start, end, qwen=None):
        if product_id not in self.products:
            raise ValueError("unknown product " + str(product_id))
        start_ms, end_ms = _ms(start), _ms(end)
        if end_ms <= start_ms:
            raise ValueError("replay range is empty")
        if qwen is not None and self.qwen_factory is None:
            raise ValueError("this server cannot ask Qwen")
        run_id = "{}-{}-{}-{}".format(time.strftime("%Y%m%d%H%M%S", time.gmtime(self.clock())),
                                      product_id, start, end)
        job = {"id": run_id, "status": "running", "product_id": product_id, "start_ms": start_ms,
               "end_ms": end_ms, "qwen": qwen, "error": None}
        with self._lock:
            self._jobs[run_id] = job
        threading.Thread(target=self._work, args=(job, self.products[product_id]), daemon=True).start()
        return self._public(job)

    def _work(self, job, tick_size):
        try:
            specs = list(self.specs_provider().values())
            blind = None
            if job["qwen"] is not None:
                blind = self.qwen_factory(specs, dict(job["qwen"], product_id=job["product_id"]), tick_size)
            run(self.market_db, self._path(job["id"]), job["product_id"], job["start_ms"], job["end_ms"],
                specs, tick_size=tick_size, qwen=blind)
            job["status"] = "done"
        except Exception as error:  # a failed run is reported, never raised into the server
            job["status"], job["error"] = "failed", "{}: {}".format(type(error).__name__, error)

    def _path(self, run_id):
        return os.path.join(self.directory, run_id + ".sqlite")

    @staticmethod
    def _public(job):
        return {k: job[k] for k in ("id", "status", "product_id", "start_ms", "end_ms", "qwen", "error")}

    def _meta(self, run_id):
        db = sqlite3.connect("file:{}?mode=ro".format(self._path(run_id)), uri=True)
        try:
            meta = {k: json.loads(v) for k, v in db.execute("SELECT key, value FROM replay_run")}
            summaries = [json.loads(r[0]) for r in db.execute("SELECT payload FROM replay_summary")]
        finally:
            db.close()
        return meta, summaries

    def list(self):
        rows = {job["id"]: self._public(job) for job in self._jobs.values() if job["status"] != "done"}
        for name in sorted(os.listdir(self.directory)):
            if name.endswith(".sqlite"):
                run_id = name[:-7]
                meta, summaries = self._meta(run_id)
                rows[run_id] = {"id": run_id, "status": "done", "product_id": meta["product_id"],
                                "start_ms": meta["start_ms"], "end_ms": meta["end_ms"],
                                "qwen": meta.get("qwen"), "error": None, "summaries": summaries}
        return sorted(rows.values(), key=lambda r: r["id"], reverse=True)

    def candles(self, run_id):
        """The replay range's 1m candles (seconds, numbers) for its chart."""
        meta, _ = self._meta(run_id) if os.path.exists(self._path(run_id)) else (None, None)
        if meta is None:
            raise KeyError("unknown replay " + run_id)
        ones, _ = load_range(self.market_db, meta["product_id"], meta["start_ms"], meta["end_ms"])
        return {"candles": [
            {"time": c["bucket_start"] // 1000, "open": float(c["open"]), "high": float(c["high"]),
             "low": float(c["low"]), "close": float(c["close"]), "volume": float(c["volume_btc"])}
            for c in ones if meta["start_ms"] <= c["bucket_start"] < meta["end_ms"]]}

    def detail(self, run_id):
        if "/" in run_id or not os.path.exists(self._path(run_id)):
            job = self._jobs.get(run_id)
            if job is None:
                raise KeyError("unknown replay " + run_id)
            return self._public(job)
        meta, summaries = self._meta(run_id)
        db = sqlite3.connect("file:{}?mode=ro".format(self._path(run_id)), uri=True)
        try:
            trades = [dict(json.loads(p), strategy_id=sid) for sid, p in db.execute(
                "SELECT strategy_id, payload FROM replay_trade ORDER BY id")]
            decisions = [dict(json.loads(p), strategy_id=sid) for sid, p in db.execute(
                "SELECT strategy_id, payload FROM replay_decision ORDER BY id")]
            qwen = None
            if meta.get("qwen"):
                qwen = {"decisions": [json.loads(r[0]) for r in db.execute(
                            "SELECT payload FROM replay_qwen_decision ORDER BY id")],
                        "report": json.loads(db.execute("SELECT payload FROM replay_qwen_report").fetchone()[0])}
        finally:
            db.close()
        return {"id": run_id, "status": "done", "meta": meta, "summaries": summaries, "trades": trades,
                "decisions": decisions, "qwen": qwen}


def qwen_factory(cache_path=None, env=None):
    """``(specs, params, tick_size) -> BlindQwen`` over the local llama.cpp server of the live process Q."""
    env = os.environ if env is None else env

    def make(specs, params, tick_size):
        from . import futures_llm_decisions as llm
        from .futures_replay_qwen import AnswerCache, BlindQwen

        questions = llm.load_questions()
        question_id = params.get("question", "trade_action")
        if question_id not in questions:
            raise ValueError("unknown question " + str(question_id))
        question = questions[question_id]
        if params.get("arm"):  # same decision, different context lines (futures_llm_lessons.ARMS)
            from .futures_llm_lessons import question_arm
            question = question_arm(question, params["arm"])
        prompts = llm.load_prompt_config()
        provider = llm.LlamaCppProvider(llm.llama_url(env), llm.model_ref(env))
        return BlindQwen(provider, specs, question, llm.load_calibration(),
                         prompts["templates"][prompts["default_version"]], tick_size=tick_size,
                         trigger=params.get("trigger", "entry"), mode=prompts["probability_source"],
                         cache=AnswerCache(cache_path), product_id=params.get("product_id", "PF_XBTUSD"))

    return make


def _ms(text):
    return int(time.mktime(time.strptime(text, "%Y-%m-%d")) - time.timezone) * 1000


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True, help="new run DB (must not exist)")
    parser.add_argument("--product", default="PF_XBTUSD")
    parser.add_argument("--from", dest="start", required=True, help="UTC date YYYY-MM-DD (inclusive)")
    parser.add_argument("--to", dest="end", required=True, help="UTC date YYYY-MM-DD (exclusive)")
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    parser.add_argument("--qwen", metavar="QUESTION_ID", help="let Qwen decide blind (e.g. trade_action)")
    parser.add_argument("--qwen-trigger", choices=("entry", "5min", "all"), default="entry",
                        help="when to ask: some strategy proposes an entry, every 5 minutes, or every minute")
    parser.add_argument("--qwen-arm", choices=("original", "context", "learning"),
                        help="context lines of the question: original (as first defined), context "
                             "(+ strategy reliability) or learning (+ Qwen's judged decisions); default: as shipped")
    parser.add_argument("--qwen-cache", help="SQLite file of cached answers shared between replays")
    parser.add_argument("--llama-url", help="default: http://127.0.0.1:$LLAMA_PORT")
    args = parser.parse_args(argv)
    specs = list(load_specs(args.specs_dir).values())
    qwen = None
    if args.qwen:
        env = dict(os.environ, **({"LLAMA_PORT": args.llama_url.rsplit(":", 1)[1]} if args.llama_url else {}))
        qwen = qwen_factory(args.qwen_cache, env)(
            specs, {"question": args.qwen, "trigger": args.qwen_trigger, "arm": args.qwen_arm,
                    "product_id": args.product}, "1")
    summaries = run(args.market_db, args.out, args.product, _ms(args.start), _ms(args.end), specs, qwen=qwen)
    json.dump(summaries, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
