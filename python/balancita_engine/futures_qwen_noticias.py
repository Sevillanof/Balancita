"""News Analyst (`futures_qwen_noticias`): exogenous fresh news catalyst enabler (OR rule with Portero).

Reads `futures-news.sqlite` in read-only mode (`mode=ro`) and evaluates whether fresh, non-price-recap
relevant news in the last 4 hours supports the Maestro's direction when the Maestro is strong (`|veredicto| == 2`).
Never blocks an entry already approved by the Portero (`portero_si == True`), and never looks ahead (`known_at <= t_ms`).
"""
import math
import hashlib
import json
import os
import re
import sqlite3
from urllib.parse import urlsplit

MINUTE_MS = 60_000
HOUR_MS = 60 * MINUTE_MS
MAX_LAG_MS = 15 * MINUTE_MS
WINDOW_MS = 4 * HOUR_MS
MIN_ALIGN = 0.10
RELEVANT_CHOSEN = ("high", "medium")
PRIORITY_POLICY = "priority_v2"
PRIORITY_MAX_AGE_MS = 15 * MINUTE_MS
PRIORITY_MIN_SUPPORT = 0.75
NEWS_HOLD_MIN = 1440
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
_PRIORITY_TOPIC_RE = re.compile(
    r"\b(ethereum|ether|eth|defi|staking|restaking|rollup|uniswap|aave|lido|"
    r"federal reserve|fed|fomc|cpi|inflation|interest rates?|sec|cftc)\b",
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


def priority_enabled(cfg):
    return (cfg.get("noticias") or {}).get("policy") == PRIORITY_POLICY


def _classification_support(raw, chosen):
    probs = json.loads(raw)
    if not isinstance(probs, dict) or chosen not in probs:
        raise ValueError("classification_missing")
    values = list(probs.values())
    if any(type(p) not in (int, float) or not math.isfinite(p) or not 0 <= p <= 1 for p in values):
        raise ValueError("classification_invalid")
    if abs(math.fsum(values) - 1) > 1e-6:
        raise ValueError("classification_not_normalized")
    return float(probs[chosen])


def _catalyst_rejection(row, stamps):
    if any(type(value) is not int or value < 0 for value in stamps):
        return "timestamps_missing"
    if not (row["published_at"] <= row["received_at"] <= min(row["relevance_at"], row["direction_at"])):
        return "timestamps_invalid"
    if row["received_at"] - row["published_at"] > PRIORITY_MAX_AGE_MS:
        return "ingestion_late"
    if row["relevance"] != "high" or row["direction"] not in ("bullish", "bearish"):
        return "not_strong_directional_news"
    if is_price_recap(row["title"]) or not _PRIORITY_TOPIC_RE.search(row["title"] + " " + row["summary"]):
        return "not_an_ethereum_or_macro_catalyst"
    return None


def _source_rejection(row, license_info, reason):
    try:
        parsed = urlsplit(row["url"])
    except (TypeError, ValueError):
        return "invalid_source_url"
    if reason is not None:
        return reason
    host = license_info.get("host")
    if (license_info.get("status") not in ("licensed", "public_domain")
            or not str(license_info.get("url") or "").startswith("https://")
            or not host or parsed.scheme != "https" or parsed.username or parsed.password
            or not parsed.hostname or not (parsed.hostname == host or parsed.hostname.endswith("." + host))):
        return "source_or_license_unverified"
    return None


def _priority_support(row):
    try:
        relevance = _classification_support(row["relevance_probs"], "high")
        direction = _classification_support(row["direction_probs"], row["direction"])
    except (TypeError, ValueError) as error:
        return "invalid_analysis: " + str(error), None, None
    if min(relevance, direction) < PRIORITY_MIN_SUPPORT:
        return "classification_support_insufficient", relevance, direction
    return None, relevance, direction


def _cluster_event(row, known_at, clusters):
    tokens = set(re.findall(r"[a-z0-9]+", row["title"].lower())) - {"the", "a", "an", "of", "to", "and", "in"}
    for cluster in clusters:
        union = tokens | cluster["tokens"]
        if known_at - cluster["known_at"] <= 2 * HOUR_MS and union and len(tokens & cluster["tokens"]) / len(union) >= 0.8:
            return cluster["event_id"]
    event_id = hashlib.sha256(("news-priority-v2:" + row["item_hash"]).encode()).hexdigest()
    clusters.append({"tokens": tokens, "known_at": known_at, "event_id": event_id})
    return event_id


def load_priority_events(db_path, policy, since_ms=0):
    """Verified classifier evidence, not calibrated probabilities of a profitable trade."""
    db = _connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(
            "SELECT i.*, r.analyzed_at AS relevance_at, r.chosen AS relevance, "
            "r.probabilities_json AS relevance_probs, r.model_ref AS relevance_model, r.prompt_hash AS relevance_prompt, "
            "d.analyzed_at AS direction_at, d.chosen AS direction, d.probabilities_json AS direction_probs, "
            "d.model_ref AS direction_model, d.prompt_hash AS direction_prompt "
            "FROM paper_futures_news_items i "
            "JOIN paper_futures_news_analysis r ON r.item_hash=i.item_hash "
            "AND r.question_id='news_relevance_btc' AND r.question_version=2 AND r.status='done' "
            "JOIN paper_futures_news_analysis d ON d.item_hash=i.item_hash "
            "AND d.question_id='news_direction' AND d.question_version=2 AND d.status='done' "
            "WHERE i.received_at>=? ORDER BY MAX(i.received_at,r.analyzed_at,d.analyzed_at),i.item_id",
            (int(since_ms),),
        ).fetchall()
    finally:
        db.close()
    events, rejected, clusters = [], [], []
    licenses = policy.get("source_licenses") or {}
    for row in rows:
        stamps = [row[k] for k in ("published_at", "received_at", "relevance_at", "direction_at")]
        known_stamps = [v for v in stamps[1:] if type(v) is int and v >= 0]
        rejection = {"item_hash": row["item_hash"], "known_at": max(known_stamps, default=None)}
        license_info = licenses.get(row["source_id"]) or {}
        reason = _source_rejection(row, license_info, _catalyst_rejection(row, stamps))
        rel_support, support = None, None
        if reason is None:
            reason, rel_support, support = _priority_support(row)
        if reason is not None:
            rejected.append(dict(rejection, reason=reason))
            continue
        known_at = max(row["received_at"], row["relevance_at"], row["direction_at"])
        if known_at >= row["published_at"] + PRIORITY_MAX_AGE_MS:
            rejected.append(dict(rejection, reason="analysis_late"))
            continue
        event_id = _cluster_event(row, known_at, clusters)
        events.append({
            "event_id": event_id, "item_hash": row["item_hash"],
            "side": 1 if row["direction"] == "bullish" else -1,
            "source": row["source"], "source_id": row["source_id"], "url": row["url"],
            "published_at": row["published_at"], "received_at": row["received_at"], "known_at": known_at,
            "expires_at": row["published_at"] + PRIORITY_MAX_AGE_MS,
            "license_status": license_info["status"], "license_url": license_info["url"],
            "relevance_support": rel_support, "direction_support": support, "rule": PRIORITY_POLICY,
            "analysis": {
                "question_version": 2, "relevance_at": row["relevance_at"], "direction_at": row["direction_at"],
                "relevance_model": row["relevance_model"], "direction_model": row["direction_model"],
                "relevance_prompt_hash": row["relevance_prompt"], "direction_prompt_hash": row["direction_prompt"],
                "support_is_calibrated_profit_probability": False,
            },
        })
    return events, rejected


class NewsFeed:
    """Read-only feed of exogenous fresh news events, safe against missing files or concurrent writes."""

    def __init__(self, db_path=None, since_ms=0, *, priority_policy=None):
        self.path = default_path() if db_path is None else db_path
        self.since_ms = int(since_ms)
        self.events = []
        self.priority_policy = priority_policy
        self.priority_events = []
        self.priority_rejections = []
        self.last_error = None
        self.available = False
        self._load()

    def _load(self):
        if not self.path or not os.path.isfile(self.path):
            self.events, self.priority_events, self.available = [], [], False
            self.priority_rejections = []
            self.last_error = "news database unavailable" if self.priority_policy is not None else None
            return
        try:
            events = load_exogenous_events(self.path, self.since_ms)
            if self.priority_policy is not None:
                self.priority_events, self.priority_rejections = load_priority_events(
                    self.path, self.priority_policy, self.since_ms)
        except sqlite3.Error as error:
            self.events, self.priority_events, self.available = [], [], False
            self.priority_rejections = []
            self.last_error = str(error)
            return
        self.events = events
        self.available = True
        self.last_error = None

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

    def priority_at(self, t_ms):
        if not self.available:
            return {"status": "unavailable", "reason": self.last_error, "rejections": []}
        known = [e for e in self.priority_events if e["known_at"] <= t_ms]
        fresh = [e for e in known if e["published_at"] <= t_ms < e["expires_at"]]
        if not fresh:
            return {"status": "none", "rejections": [
                r for r in self.priority_rejections if r["known_at"] is not None
                and t_ms - PRIORITY_MAX_AGE_MS <= r["known_at"] <= t_ms]}
        if len({e["side"] for e in fresh}) != 1:
            return {"status": "conflict", "reason": "noticias fuertes contradictorias"}
        selected = dict(fresh[-1])
        selected["item_hashes"] = [e["item_hash"] for e in known if e["event_id"] == selected["event_id"]]
        return {"status": "signal", "signal": selected}

    def lifecycle_at(self, t_ms, *, consumed_event_ids=()):
        active = self.priority_policy is not None
        view = {
            "policy": PRIORITY_POLICY if active else "legacy_v1", "checked_at_ms": t_ms,
            "available": self.available, "reason": self.last_error or ("news_database_unavailable" if not self.available else None),
            "expiry_basis": "published_at" if active else "known_at",
            "max_age_ms": PRIORITY_MAX_AGE_MS if active else WINDOW_MS,
            "source_licenses": (self.priority_policy or {}).get("source_licenses") or {},
            "items": {},
        }
        if not active or not self.available:
            return view
        selection = self.priority_at(t_ms)
        view["status"] = selection["status"]
        view["items"] = self._lifecycle_items(t_ms, selection, consumed_event_ids)
        return view

    def _lifecycle_items(self, t_ms, selection, consumed_event_ids):
        items = {}
        for rejected in self.priority_rejections:
            if rejected["known_at"] is not None and rejected["known_at"] <= t_ms:
                items[rejected["item_hash"]] = {"status": "rejected", "reason": rejected["reason"]}
        selected_id = (selection.get("signal") or {}).get("event_id")
        for event in self.priority_events:
            if event["known_at"] > t_ms:
                continue
            status = _event_lifecycle_status(event, t_ms, consumed_event_ids, selection["status"], selected_id)
            items[event["item_hash"]] = {
                "status": status, "event_id": event["event_id"], "expires_at_ms": event["expires_at"]}
        return items


def _event_lifecycle_status(event, t_ms, consumed_event_ids, selection_status, selected_id):
    if event["event_id"] in consumed_event_ids:
        return "used"
    if event["expires_at"] <= t_ms:
        return "expired"
    if selection_status == "conflict":
        return "conflict"
    return "eligible" if event["event_id"] == selected_id else "not_selected"


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
