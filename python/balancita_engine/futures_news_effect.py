"""Read-only report: does the ETH price move the way Qwen's news labels said it would?

Usage: python -m balancita_engine.futures_news_effect --news-db N --market-db M [--desde D] [--hasta D] [--json]
"""

import argparse
import bisect
import json
import math
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone

PRODUCT = "PF_ETHUSD"
CANDLE_MS = 5 * 60_000
HOUR_MS = 60 * 60_000
MAX_PRICE_AGE_MS = HOUR_MS
HORIZONS = (("1h", HOUR_MS), ("4h", 4 * HOUR_MS), ("12h", 12 * HOUR_MS))
SIGN = {"bullish": 1, "bearish": -1}
GROUPINGS = (
    ("source", lambda r: r["source_id"]),
    ("relevance", lambda r: r["relevance"]),
    ("direction", lambda r: r["direction"]),
    ("source/relevance/direction", lambda r: "{}/{}/{}".format(r["source_id"], r["relevance"], r["direction"])),
)


def _open(path):
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    return sqlite3.connect("file:{}?mode=ro".format(path), uri=True)


class Prices:
    """ETH close known at a time: the last 5m candle already closed, never older than 1 h."""

    def __init__(self, db):
        rows = db.execute(
            "SELECT bucket_start, close_price FROM paper_futures_official_candles c "
            "WHERE product_id=? AND interval_ms=? AND known_at=(SELECT MAX(known_at) "
            "FROM paper_futures_official_candles WHERE product_id=c.product_id "
            "AND interval_ms=c.interval_ms AND bucket_start=c.bucket_start) "
            "GROUP BY bucket_start ORDER BY bucket_start", (PRODUCT, CANDLE_MS)).fetchall()
        self.closed_at = [start + CANDLE_MS for start, _ in rows]
        self.close = [float(price) for _, price in rows]

    def at(self, t):
        i = bisect.bisect_right(self.closed_at, t) - 1
        if i < 0 or t - self.closed_at[i] >= MAX_PRICE_AGE_MS:
            return None
        return self.close[i]

    def move_bp(self, start, end):
        a, b = self.at(start), self.at(end)
        return None if a is None or b is None else round((b - a) / a * 10_000, 1)


def _in_range(t, since_ms, until_ms):
    return (since_ms is None or t >= since_ms) and (until_ms is None or t < until_ms)


def _rank(values, q):
    ordered = sorted(values)
    return float(ordered[max(1, math.ceil(q * len(ordered))) - 1])


def _news(db):
    rows = db.execute("""
        SELECT i.item_hash, i.source_id, i.title, i.published_at, i.received_at,
               r.status, r.analyzed_at, r.chosen, d.status, d.analyzed_at, d.chosen
          FROM paper_futures_news_items i
          LEFT JOIN paper_futures_news_analysis r ON r.item_hash=i.item_hash
           AND r.question_id='news_relevance_btc' AND r.question_version=2
          LEFT JOIN paper_futures_news_analysis d ON d.item_hash=i.item_hash
           AND d.question_id='news_direction' AND d.question_version=2
         ORDER BY i.item_id""").fetchall()
    news = {}
    for h, source, title, published, received, rs, ra, rc, ds, da, dc in rows:
        entry = news.setdefault(h, {"item_hash": h, "source_id": source, "title": title,
                                    "published_at": published, "received_at": received,
                                    "done": None, "statuses": set()})
        entry["statuses"].update(s for s in (rs, ds) if s)
        if rs == "done" and ds == "done" and entry["done"] is None:
            entry["done"] = (max(received, ra, da), rc, dc)
    return list(news.values())


def _group(items):
    groups = []
    for name, key_of in GROUPINGS:
        buckets = defaultdict(list)
        for row in items:
            buckets[key_of(row)].append(row)
        for key in sorted(buckets):
            stats = {"by": name, "key": key, "n": {}, "hit_pct": {}, "avg_bp": {}}
            for label, _ in HORIZONS:
                moves = [r["moves_bp"][label] for r in buckets[key] if r["moves_bp"][label] is not None]
                stats["n"][label] = len(moves)
                stats["hit_pct"][label] = round(100 * sum(m > 0 for m in moves) / len(moves), 1) if moves else None
                stats["avg_bp"][label] = round(sum(moves) / len(moves), 1) if moves else None
            groups.append(stats)
    return groups


def measure(news_path, market_path, since_ms=None, until_ms=None):
    news_db, market_db = _open(news_path), _open(market_path)
    try:
        prices = Prices(market_db)
        news = _news(news_db)
    finally:
        news_db.close()
        market_db.close()
    items, neutral, skipped, latency = [], [], [], defaultdict(list)
    for n in news:
        if n["published_at"] is not None and _in_range(n["received_at"], since_ms, until_ms):
            latency[n["source_id"]].append((n["received_at"] - n["published_at"]) / 60_000)
        if n["done"] is None:
            status = next((s for s in ("skipped_stale", "failed") if s in n["statuses"]), None)
            if status and _in_range(n["received_at"], since_ms, until_ms):
                skipped.append({"item_hash": n["item_hash"], "source_id": n["source_id"], "status": status,
                                "title": n["title"], "received_at_ms": n["received_at"],
                                "abs_move_1h_bp": _abs(prices.move_bp(n["received_at"], n["received_at"] + HOUR_MS))})
            continue
        known, relevance, direction = n["done"]
        if not _in_range(known, since_ms, until_ms):
            continue
        raw = {label: prices.move_bp(known, known + span) for label, span in HORIZONS}
        if direction in SIGN:
            items.append({"item_hash": n["item_hash"], "source_id": n["source_id"], "title": n["title"],
                          "relevance": relevance, "direction": direction, "known_at_ms": known,
                          "moves_bp": {k: None if v is None else round(v * SIGN[direction], 1) for k, v in raw.items()}})
        else:
            neutral.append({"item_hash": n["item_hash"], "source_id": n["source_id"], "relevance": relevance,
                            "abs_moves_bp": {k: _abs(v) for k, v in raw.items()}})
    items.sort(key=lambda r: (r["known_at_ms"], r["item_hash"]))
    counts = defaultdict(int)
    for row in skipped:
        counts[row["status"]] += 1
    return {
        "range": {"since_ms": since_ms, "until_ms": until_ms},
        "items": items,
        "neutral": neutral,
        "groups": _group(items),
        "latency": [{"source_id": s, "n": len(v), "median_min": _rank(v, 0.5), "p90_min": _rank(v, 0.9)}
                    for s, v in sorted(latency.items())],
        "skipped": {"count_by_status": dict(counts), "items": skipped},
    }


def _abs(value):
    return None if value is None else abs(value)


def _fmt(value, suffix=""):
    return "—" if value is None else "{:+.1f}{}".format(value, suffix) if suffix == " pb" else "{:.1f}{}".format(value, suffix)


def render(report):
    out = ["Noticias con dirección: {}  ·  neutrales: {}  ·  descartadas sin análisis: {}".format(
        len(report["items"]), len(report["neutral"]), len(report["skipped"]["items"]))]
    for by in ("relevance", "direction", "source"):
        out.append("")
        out.append("Por {} (acierto % · pb medio a favor, a 1 h / 4 h / 12 h)".format(
            {"relevance": "relevancia", "direction": "dirección", "source": "fuente"}[by]))
        for g in (g for g in report["groups"] if g["by"] == by):
            cells = ["n={} acierto {} · {}".format(g["n"][h], _fmt(g["hit_pct"][h], " %"), _fmt(g["avg_bp"][h], " pb"))
                     for h, _ in HORIZONS]
            label = "relevancia " + g["key"] if by == "relevance" else g["key"]
            out.append("  {:<22} {}".format(label, "  |  ".join(cells)))
    out.append("")
    out.append("Latencia de ingesta (minutos desde la publicación: mediana / p90)")
    for row in report["latency"]:
        out.append("  {:<22} n={:<4} {:.0f} / {:.0f}".format(row["source_id"], row["n"], row["median_min"], row["p90_min"]))
    out.append("")
    out.append("Descartadas sin análisis, por movimiento de ETH en la hora siguiente")
    for row in sorted(report["skipped"]["items"], key=lambda r: -(r["abs_move_1h_bp"] or 0))[:10]:
        out.append("  {:>7}  {:<14} {}".format(_fmt(row["abs_move_1h_bp"], " pb"), row["source_id"], row["title"][:80]))
    return "\n".join(out)


def _day_ms(text):
    return int(datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Mide si las noticias analizadas por Qwen anticipan el precio de ETH.")
    parser.add_argument("--news-db", required=True)
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--desde", help="AAAA-MM-DD (UTC, incluido)")
    parser.add_argument("--hasta", help="AAAA-MM-DD (UTC, sin incluir)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = measure(args.news_db, args.market_db,
                         since_ms=_day_ms(args.desde) if args.desde else None,
                         until_ms=_day_ms(args.hasta) if args.hasta else None)
    except FileNotFoundError as error:
        print("la base no existe: {}".format(error), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True) if args.json else render(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
