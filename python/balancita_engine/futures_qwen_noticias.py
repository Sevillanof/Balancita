"""News Analyst (`futures_qwen_noticias`): exogenous fresh news catalyst enabler (OR rule with Portero).

Reads `futures-news.sqlite` in read-only mode (`mode=ro`) and evaluates whether fresh, non-price-recap
relevant news in the last 4 hours supports the Maestro's direction when the Maestro is strong (`|veredicto| == 2`).
Never blocks an entry already approved by the Portero (`portero_si == True`), and never looks ahead (`known_at <= t_ms`).
"""
import math
import os
import re
import sqlite3

MINUTE_MS = 60_000
HOUR_MS = 60 * MINUTE_MS
MAX_LAG_MS = 15 * MINUTE_MS
WINDOW_MS = 4 * HOUR_MS
MIN_ALIGN = 0.10
RELEVANT_CHOSEN = ("high", "medium")
DEFAULT_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "server", "data", "dev-live", "futures-news.sqlite")
)

_PRICE_RECAP_RE = re.compile(
    r"(\$\d|\b\d{2,3}k\b|slides|drops|falls|plunges|surges|rallies|jumps|soars|"
    r"holds above|circles|rebounds|dips|tops|hits|climbs|sinks|tumbles|price|live updates)",
    re.IGNORECASE,
)
_BTC_ONLY_RE = re.compile(
    r"\b(bitcoin|btc|satoshi|halving|hashrate|ordinals|runes|microstrategy|saylor|bitcoiner)\b",
    re.IGNORECASE,
)
_ETH_OR_MACRO_RE = re.compile(
    r"\b(eth|ethereum|ether|vitalik|pectra|fusaka|eip|layer 2|l2|rollup|zk|defi|staking|restaking|"
    r"uniswap|aave|lido|arbitrum|optimism|base|crypto|market|markets|sec|cftc|fed|fomc|cpi|"
    r"inflation|tariff|etf|etfs|stablecoin|usdc|tether)\b",
    re.IGNORECASE,
)


def default_path(env=None):
    """Path to the news SQLite database (`$NEWS_DB_PATH` or `server/data/dev-live/futures-news.sqlite`)."""
    env = os.environ if env is None else env
    return (env.get("NEWS_DB_PATH") or "").strip() or DEFAULT_PATH


def is_price_recap(title):
    """True when the headline narrates a price level or recent move rather than an exogenous catalyst."""
    return bool(_PRICE_RECAP_RE.search(str(title or "")))


def is_btc_only(title, summary=""):
    """True when the item is exclusively about Bitcoin without Ethereum, DeFi/L2, or macro/market-wide relevance."""
    text = "{} {}".format(title or "", summary or "")
    return bool(_BTC_ONLY_RE.search(text) and not _ETH_OR_MACRO_RE.search(text))


def is_irrelevant_headline(title, summary=""):
    """True when the item is a price recap or Bitcoin-only noise irrelevant to Ethereum."""
    return is_price_recap(title) or is_btc_only(title, summary)


def _connect(db_path):
    return sqlite3.connect("file:{}?mode=ro".format(db_path), uri=True)


def _event_weight(r_val, r_chosen):
    if r_val is not None:
        return float(r_val)
    return 1.0 if r_chosen == "high" else 0.6


def _event_sign(d_chosen):
    if d_chosen == "bullish":
        return 1.0
    if d_chosen == "bearish":
        return -1.0
    return 0.0


def load_exogenous_events(db_path, since_ms=0):
    """Returns sorted `(known_at_ms, weight, sign)` for fresh exogenous relevant items."""
    db = _connect(db_path)
    try:
        rows = db.execute(
            "SELECT i.item_hash, i.title, i.summary, i.published_at, i.received_at, "
            "r.question_version, r.analyzed_at, r.chosen, r.value, d.analyzed_at, d.chosen "
            "FROM paper_futures_news_items i "
            "JOIN paper_futures_news_analysis r ON r.item_hash=i.item_hash "
            "  AND r.question_id='news_relevance_btc' AND r.question_version IN (1, 2) AND r.status='done' "
            "JOIN paper_futures_news_analysis d ON d.item_hash=i.item_hash "
            "  AND d.question_id='news_direction' AND d.question_version=r.question_version AND d.status='done' "
            "WHERE i.received_at >= ? AND i.published_at IS NOT NULL "
            "  AND (i.received_at - i.published_at) BETWEEN 0 AND ? "
            "  AND r.chosen IN ('high', 'medium') "
            "ORDER BY i.received_at, r.question_version DESC",
            (int(since_ms), MAX_LAG_MS),
        ).fetchall()
    finally:
        db.close()

    events = []
    seen = set()
    for ihash, title, summary, _, rec_ms, _, r_ana_ms, r_chosen, r_val, d_ana_ms, d_chosen in rows:
        if ihash in seen:
            continue
        seen.add(ihash)
        if is_irrelevant_headline(title, summary):
            continue
        known_at = max(int(rec_ms), int(r_ana_ms), int(d_ana_ms))
        events.append((known_at, _event_weight(r_val, r_chosen), _event_sign(d_chosen)))
    events.sort(key=lambda item: item[0])
    return events


class NewsFeed:
    """Read-only feed of exogenous fresh news events, safe against missing files or concurrent writes."""

    def __init__(self, db_path=None, since_ms=0):
        self.path = default_path() if db_path is None else db_path
        self.since_ms = int(since_ms)
        self.events = []
        self.available = False
        self._load()

    def _load(self):
        if not self.path or not os.path.isfile(self.path):
            self.events, self.available = [], False
            return
        try:
            events = load_exogenous_events(self.path, self.since_ms)
        except sqlite3.Error:
            return
        self.events = events
        self.available = True

    def reload(self, since_ms=None):
        if since_ms is not None:
            self.since_ms = int(since_ms)
        self._load()
        return self.available

    def window_stats(self, t_ms, window_ms=WINDOW_MS):
        t = int(t_ms)
        lo = t - int(window_ms)
        sub = [e for e in self.events if lo < e[0] <= t]
        if not sub:
            return 0, 0.0, 0.0
        w_sum = math.fsum(e[1] for e in sub)
        signed = math.fsum(e[1] * e[2] for e in sub)
        max_rel = max(e[1] for e in sub)
        return len(sub), (signed / w_sum if w_sum > 0 else 0.0), max_rel


def verdict(feed, t_ms, side, window_ms=WINDOW_MS, min_align=MIN_ALIGN):
    """Returns `(noticias_si, detail_dict)` for `side` (+1 long, -1 short) at `t_ms` without look-ahead."""
    if feed is None or not getattr(feed, "available", False):
        return False, {
            "disponible": False,
            "n": 0,
            "sentimiento": 0.0,
            "max_relevancia": 0.0,
            "a_favor": False,
        }
    n, sentiment, max_rel = feed.window_stats(t_ms, window_ms=window_ms)
    ok = bool(n > 0 and side in (-1, 1) and side * sentiment >= min_align)
    return ok, {
        "disponible": True,
        "n": n,
        "sentimiento": round(sentiment, 6),
        "max_relevancia": round(max_rel, 6),
        "a_favor": ok,
    }
