"""News process N: public news in, timestamped local-model features out.

N polls public RSS/Atom feeds, stores every item with the time it was received,
and (optionally) asks the local Qwen the ``news``-scope questions of the catalog
``config/decision-questions.json`` about each new item. Everything lands in its own
append-only SQLite file, of which N is the single writer. Downstream code (the
verdict service C, later) reads the stored rows only, through ``news_features``;
it never talks to the model.

Design rules
------------
* Ingest never needs the model. Items are stored with ``received_at`` (the wall
  clock when N first saw them), the feed's ``published_at`` (kept as data, never
  used for knowledge time) and two hashes: ``item_hash`` (dedupe: canonical URL +
  normalized title) and ``content_hash`` (title + summary).
* Feed text is untrusted. It is flattened to one line of plain text (tags and
  entities decoded, NFKC folded so look-alike delimiters collapse), the prompt
  delimiters ``STATE:`` and ``QUESTION:`` are neutralized with Q's own
  ``sanitize_text``, and title and summary are capped. XML with a DTD or entity
  declarations is refused, bodies are capped, every request has a timeout.
* Analysis reuses Q's code and nothing else: the same ``LlamaCppProvider`` (loopback
  only, logprobs plus grammar), ``build_prompt``, ``ask_model``/``convert`` (probabilities,
  confidence, calibration temperature) and prompt templates. The questions are data
  (``scope: "news"`` in the catalog). A row is keyed by ``(item_hash, question_id,
  question_version)``. The model never leaves the machine and news is never sent to a
  remote API.
* A pending analysis is an item with no row for a question. If the model is down
  nothing is written for it, and it is retried while the item was received within
  ``retry_window_ms``; afterwards (or for a backlog item published long before it was
  received) an explicit ``skipped_stale`` row is written and the model is never asked,
  so a restart cannot cause a catch-up storm. A response error is stored in the errors
  table and, after ``max_attempts`` of them, a ``failed`` row ends the retries.
* ``news_features(db, t)`` is pure over the stored rows and has no lookahead: an item
  counts at decision time ``t`` only if it was received at or before ``t`` and both of
  its answers were stored at or before ``t``.
* Stdlib only, Python 3.9+.
"""

import json
import math
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import namedtuple
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta, timezone
from html import unescape

from .futures_llm_decisions import (
    LOOPBACK_HOSTS,
    SOURCE_MODES,
    LlamaCppProvider,
    ModelResponseError,
    ModelUnavailable,
    ask_model,
    build_prompt,
    load_calibration,
    load_prompt_config,
    load_questions,
    llama_url,
    model_ref,
    prompt_hash,
    question_letters,
    sanitize_text,
    temperature_for,
    text_hash,
)

_CONFIG_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config"
)
SOURCES_PATH = os.path.join(_CONFIG_DIR, "news-sources.json")

MINUTE_MS = 60_000
HOUR_MS = 60 * MINUTE_MS
MIN_INTERVAL_MS = MINUTE_MS
DEFAULT_INTERVAL_MS = 5 * MINUTE_MS
DEFAULT_RETRY_WINDOW_MS = 30 * MINUTE_MS
DEFAULT_MAX_PUBLISHED_AGE_MS = 6 * HOUR_MS
DEFAULT_MAX_ANALYSES_PER_POLL = 20
DEFAULT_MAX_ATTEMPTS = 3
MAX_FEED_BYTES = 2_000_000
DEFAULT_FETCH_TIMEOUT = 15.0
DEFAULT_USER_AGENT = "Balancita-news/1.0 (+local research; polite RSS polling)"
UNRESOLVED_BATCH = 2000
MAX_BACKOFF_FACTOR = 8

# Shape of what is stored: changing any of it needs a new DB (config hash guard).
NEWS_CONFIG = {
    "version": "futures-news-config.v1",
    "item_schema": "futures-news-item.v1",
    "dedupe": "sha256(canonical_url + newline + lowercase-collapsed title)",
    "max_title_chars": 300,
    "max_summary_chars": 1500,
    "max_items_per_feed": 100,
}
CONFIG_MISMATCH = "news DB was written with a different config; use a new DB"

RELEVANCE_QUESTION = ("news_relevance_btc", 1)
DIRECTION_QUESTION = ("news_direction", 1)
# An item is "relevant" when P(medium) + P(high) reaches this.
RELEVANT_OPTIONS = ("medium", "high")
RELEVANT_THRESHOLD = 0.5
FEATURE_WINDOWS = (("1h", HOUR_MS), ("4h", 4 * HOUR_MS))

_SOURCE_ID = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


class FeedError(Exception):
    """The body is not a usable RSS/Atom feed."""


class FetchError(Exception):
    """The feed could not be fetched (network, HTTP status, size, timeout)."""


FetchResult = namedtuple("FetchResult", "status body etag last_modified")


# --------------------------------------------------------------------------- text

_SCRIPT = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_TAG = re.compile(r"<[^<>]{0,2000}>")


def clean_text(raw, limit):
    """Untrusted feed text -> one line of plain text, delimiters neutralized, capped."""
    if raw is None:
        return ""
    text = unicodedata.normalize("NFKC", str(raw))
    text = _SCRIPT.sub(" ", text)
    text = _TAG.sub(" ", text)
    text = unescape(text)
    text = sanitize_text(text)
    text = " ".join(text.split())
    return text[:limit].strip()


def canonical_url(url, base=None):
    """http(s) URL without fragment, credentials, default port or ``utm_*`` parameters, else ``""``."""
    try:
        text = str(url or "").strip()
        if base:
            text = urllib.parse.urljoin(base, text)
        parts = urllib.parse.urlsplit(text)
        scheme = parts.scheme.lower()
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return ""
    if scheme not in ("http", "https") or not host:
        return ""
    if port is not None and port != (443 if scheme == "https" else 80):
        host = "{}:{}".format(host, port)
    query = "&".join(p for p in parts.query.split("&") if p and not p.lower().startswith("utm_"))
    return urllib.parse.urlunsplit((scheme, host, parts.path or "/", query, ""))


def item_hash(url, title):
    identity = canonical_url(url) or str(url or "").strip()
    return text_hash(identity + "\n" + " ".join(str(title).lower().split()))


# --------------------------------------------------------------------------- feeds

_DTD = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)
_ISO = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$",
    re.IGNORECASE,
)


def parse_date(text):
    """RFC 822 or ISO 8601 -> UTC epoch milliseconds, or ``None``."""
    text = (text or "").strip()
    if not text:
        return None
    moment = None
    try:
        moment = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        match = _ISO.match(text)
        if match:
            year, month, day, hour, minute, second, zone = match.groups()
            try:
                moment = datetime(int(year), int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0))
            except ValueError:
                return None
            if zone and zone.upper() != "Z":
                sign = 1 if zone[0] == "+" else -1
                digits = zone[1:].replace(":", "")
                moment = moment.replace(tzinfo=timezone(sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))))
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    try:
        value = int(moment.timestamp() * 1000)
    except (OverflowError, OSError, ValueError):
        return None
    return value if value > 0 else None


def _local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _text(element):
    return "".join(element.itertext()).strip() if element is not None else ""


def _first_text(entry, names):
    for name in names:
        for child in entry.findall("{*}" + name):
            text = _text(child)
            if text:
                return text
    return ""


def _entry_link(entry):
    candidates = []
    for child in entry.findall("{*}link"):
        href = (child.get("href") or "").strip()
        if href:
            candidates.append((0 if child.get("rel") in (None, "", "alternate") else 1, href))
        elif _text(child):
            candidates.append((0, _text(child)))
    return min(candidates)[1] if candidates else ""


def parse_feed(data, base_url, max_items=None):
    """RSS 2.0, RSS 1.0 (RDF) or Atom bytes -> ``[{title, link, guid, summary, published_ms}]`` (raw text)."""
    if max_items is None:
        max_items = NEWS_CONFIG["max_items_per_feed"]
    if not data or not data.strip():
        raise FeedError("empty response")
    if _DTD.search(data):
        raise FeedError("DTD and entity declarations are not accepted")
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, ValueError) as error:
        raise FeedError("invalid XML: {}".format(error)) from error
    kind = _local(root.tag)
    if kind not in ("rss", "feed", "RDF"):
        raise FeedError("not an RSS or Atom feed (root <{}>)".format(kind))
    entries = root.iterfind(".//{*}entry" if kind == "feed" else ".//{*}item")
    items = []
    for entry in entries:
        title = _first_text(entry, ("title",))
        if not title:
            continue
        link = _entry_link(entry)
        link = urllib.parse.urljoin(base_url, link) if link else ""
        guid = _first_text(entry, ("guid", "id")) or link
        items.append({
            "title": title,
            "link": link,
            "guid": guid,
            "summary": _first_text(entry, ("description", "summary", "content", "encoded")),
            "published_ms": parse_date(_first_text(entry, ("pubDate", "published", "updated", "date"))),
        })
        if len(items) >= max_items:
            break
    return items


# --------------------------------------------------------------------------- sources


def _valid_url(url):
    try:
        parts = urllib.parse.urlsplit(str(url))
        host = (parts.hostname or "").lower()
        parts.port  # noqa: B018 - raises ValueError on a bad port
    except ValueError:
        return False
    if not host:
        return False
    return parts.scheme == "https" or (parts.scheme == "http" and host in LOOPBACK_HOSTS)


def validate_sources(sources):
    if not isinstance(sources, list) or not sources:
        raise ValueError("sources must be a non-empty list")
    seen = set()
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("source must be an object")
        name = source.get("id")
        if not isinstance(name, str) or not _SOURCE_ID.match(name):
            raise ValueError("invalid source id {!r}".format(name))
        if name in seen:
            raise ValueError("duplicate source id {}".format(name))
        seen.add(name)
        if not isinstance(source.get("name"), str) or not source["name"].strip():
            raise ValueError("{}: name is required".format(name))
        if not _valid_url(source.get("url")):
            raise ValueError("{}: url must be https (http only for loopback)".format(name))
    return sources


def load_sources(path=None):
    with open(path or SOURCES_PATH) as handle:
        body = json.load(handle)
    return validate_sources(body.get("sources") if isinstance(body, dict) else body)


def parse_extra_feeds(text):
    """``NEWS_EXTRA_RSS_FEEDS``, the legacy format: ``id|label|https url[|license]`` comma separated."""
    sources = []
    for entry in (text or "").split(","):
        if not entry.strip():
            continue
        fields = [field.strip() for field in entry.split("|")]
        if not 3 <= len(fields) <= 4:
            raise ValueError("NEWS_EXTRA_RSS_FEEDS entry {!r} must be id|label|https url[|license]".format(entry.strip()))
        sources.append({"id": fields[0], "name": fields[1], "url": fields[2]})
    if sources:
        validate_sources(sources)
    return sources


def configured_sources(path, env):
    sources = load_sources(path)
    known = {source["id"] for source in sources}
    for extra in parse_extra_feeds(env.get("NEWS_EXTRA_RSS_FEEDS", "")):
        if extra["id"] not in known:
            sources.append(extra)
            known.add(extra["id"])
    return sources


# --------------------------------------------------------------------------- fetcher


class UrlFetcher:
    """Polite HTTP GET of a feed: timeout, size cap, conditional requests, http(s) only."""

    def __init__(self, timeout=DEFAULT_FETCH_TIMEOUT, user_agent=DEFAULT_USER_AGENT, max_bytes=MAX_FEED_BYTES):
        self.timeout = timeout
        self.user_agent = user_agent
        self.max_bytes = max_bytes
        # Only http(s) handlers (no file:, ftp:), proxies from the environment: the feeds are public.
        self._opener = urllib.request.OpenerDirector()
        for handler in (
            urllib.request.ProxyHandler(), urllib.request.HTTPHandler(), urllib.request.HTTPSHandler(),
            urllib.request.HTTPRedirectHandler(), urllib.request.HTTPDefaultErrorHandler(),
            urllib.request.HTTPErrorProcessor(),
        ):
            self._opener.add_handler(handler)

    def fetch(self, url, etag=None, last_modified=None):
        if urllib.parse.urlsplit(str(url)).scheme not in ("http", "https"):
            raise FetchError("only http(s) feeds are fetched")
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        }
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        started = time.monotonic()
        try:
            with self._opener.open(urllib.request.Request(url, headers=headers), timeout=self.timeout) as response:
                declared = response.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > self.max_bytes:
                    raise FetchError("response too large ({} bytes)".format(declared))
                chunks, size = [], 0
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise FetchError("response too large (over {} bytes)".format(self.max_bytes))
                    chunks.append(chunk)
                    if time.monotonic() - started > self.timeout:
                        raise FetchError("timed out after {}s".format(self.timeout))
                return FetchResult(response.status, b"".join(chunks), response.headers.get("ETag"),
                                   response.headers.get("Last-Modified"))
        except urllib.error.HTTPError as error:
            try:
                if error.code == 304:
                    return FetchResult(304, b"", etag, last_modified)
                raise FetchError("HTTP {}".format(error.code)) from error
            finally:
                error.close()
        except FetchError:
            raise
        except Exception as error:  # URLError, timeouts, TLS, http.client errors
            raise FetchError("{}: {}".format(type(error).__name__, error)) from error


# --------------------------------------------------------------------------- store

_ANALYSIS_STATUSES = ("done", "skipped_stale", "failed")


class NewsStore:
    """Single writer of the news DB: append-only items, analyses and errors."""

    def __init__(self, path, config):
        self.config = dict(config)
        self.config_hash = text_hash(json.dumps(self.config, sort_keys=True, separators=(",", ":")))
        self.db = sqlite3.connect(path)
        self.db.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS paper_futures_news_meta(
              key TEXT PRIMARY KEY, value TEXT NOT NULL
            ) STRICT;
            CREATE TRIGGER IF NOT EXISTS paper_futures_news_meta_no_update
              BEFORE UPDATE ON paper_futures_news_meta BEGIN SELECT RAISE(ABORT, 'news is immutable'); END;
            CREATE TRIGGER IF NOT EXISTS paper_futures_news_meta_no_delete
              BEFORE DELETE ON paper_futures_news_meta BEGIN SELECT RAISE(ABORT, 'news is immutable'); END;
            """
        )
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO paper_futures_news_meta VALUES('config_json', ?)",
                            (json.dumps(self.config, sort_keys=True),))
            self.db.execute("INSERT OR IGNORE INTO paper_futures_news_meta VALUES('config_hash', ?)", (self.config_hash,))
        stored = self.db.execute("SELECT value FROM paper_futures_news_meta WHERE key='config_hash'").fetchone()[0]
        if stored != self.config_hash:
            self.db.close()
            raise ValueError(CONFIG_MISMATCH)
        # items.item_id is the rowid cursor for readers; item_hash is the dedupe key.
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS paper_futures_news_items(
              item_id INTEGER PRIMARY KEY, item_hash TEXT NOT NULL UNIQUE,
              source_id TEXT NOT NULL, source TEXT NOT NULL, url TEXT NOT NULL,
              title TEXT NOT NULL, summary TEXT NOT NULL,
              published_at INTEGER, received_at INTEGER NOT NULL, content_hash TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS paper_futures_news_items_received ON paper_futures_news_items(received_at);
            CREATE TABLE IF NOT EXISTS paper_futures_news_analysis(
              analysis_id INTEGER PRIMARY KEY,
              item_hash TEXT NOT NULL, question_id TEXT NOT NULL, question_version INTEGER NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('done','skipped_stale','failed')),
              analyzed_at INTEGER NOT NULL,
              question_type TEXT, model_ref TEXT, model_info_json TEXT, prompt_hash TEXT, prompt_version INTEGER,
              probability_source TEXT, top_logprobs_json TEXT, probabilities_json TEXT, temperature REAL,
              chosen TEXT, value REAL, confidence REAL, latency_ms INTEGER, timings_json TEXT,
              UNIQUE(item_hash, question_id, question_version),
              CHECK(status != 'done' OR (question_type IS NOT NULL AND model_ref IS NOT NULL
                AND probabilities_json IS NOT NULL AND chosen IS NOT NULL AND confidence IS NOT NULL
                AND prompt_hash IS NOT NULL))
            ) STRICT;
            CREATE INDEX IF NOT EXISTS paper_futures_news_analysis_time ON paper_futures_news_analysis(analyzed_at);
            CREATE TABLE IF NOT EXISTS paper_futures_news_errors(
              error_id INTEGER PRIMARY KEY, item_hash TEXT NOT NULL, question_id TEXT NOT NULL,
              question_version INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
              model_ref TEXT NOT NULL, written_at INTEGER NOT NULL
            ) STRICT;
            """
        )
        for table in ("items", "analysis", "errors"):
            self.db.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS paper_futures_news_{t}_no_update
                  BEFORE UPDATE ON paper_futures_news_{t} BEGIN SELECT RAISE(ABORT, 'news is immutable'); END;
                CREATE TRIGGER IF NOT EXISTS paper_futures_news_{t}_no_delete
                  BEFORE DELETE ON paper_futures_news_{t} BEGIN SELECT RAISE(ABORT, 'news is immutable'); END;
                """.format(t=table)
            )

    def add_item(self, row):
        """Appends an item; returns its ``item_id`` or ``None`` when ``item_hash`` is already stored."""
        with self.db:
            cursor = self.db.execute(
                "INSERT OR IGNORE INTO paper_futures_news_items(item_hash, source_id, source, url, title, summary, "
                "published_at, received_at, content_hash) VALUES(?,?,?,?,?,?,?,?,?)",
                (row["item_hash"], row["source_id"], row["source"], row["url"], row["title"], row["summary"],
                 row["published_at"], row["received_at"], row["content_hash"]),
            )
        return cursor.lastrowid if cursor.rowcount else None

    def append_analysis(self, row):
        dump = lambda value: None if value is None else json.dumps(value, sort_keys=True, separators=(",", ":"))
        with self.db:
            self.db.execute(
                "INSERT INTO paper_futures_news_analysis(item_hash, question_id, question_version, status, "
                "analyzed_at, question_type, model_ref, model_info_json, prompt_hash, prompt_version, "
                "probability_source, top_logprobs_json, probabilities_json, temperature, chosen, value, "
                "confidence, latency_ms, timings_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    row["item_hash"], row["question_id"], row["question_version"], row["status"], row["analyzed_at"],
                    row.get("question_type"), row.get("model_ref"), dump(row.get("model_info")),
                    row.get("prompt_hash"), row.get("prompt_version"), row.get("probability_source"),
                    dump(row.get("top_logprobs")), dump(row.get("probabilities")), row.get("temperature"),
                    row.get("chosen"), row.get("value"), row.get("confidence"), row.get("latency_ms"),
                    dump(row.get("timings")),
                ),
            )

    def append_error(self, row):
        with self.db:
            self.db.execute(
                "INSERT INTO paper_futures_news_errors(item_hash, question_id, question_version, kind, message, "
                "model_ref, written_at) VALUES(?,?,?,?,?,?,?)",
                (row["item_hash"], row["question_id"], row["question_version"], row["kind"],
                 str(row["message"])[:500], row["model_ref"], int(time.time() * 1000)),
            )

    def error_count(self, item_hash_, question_id, version):
        return self.db.execute(
            "SELECT COUNT(*) FROM paper_futures_news_errors WHERE item_hash=? AND question_id=? AND question_version=?",
            (item_hash_, question_id, version),
        ).fetchone()[0]

    def unresolved(self, question_id, version, limit=UNRESOLVED_BATCH):
        """Items with no analysis row (any status) for one question version, newest stored first."""
        return self.db.execute(
            "SELECT i.item_id, i.item_hash, i.title, i.summary, i.published_at, i.received_at "
            "FROM paper_futures_news_items i WHERE NOT EXISTS (SELECT 1 FROM paper_futures_news_analysis a "
            "WHERE a.item_hash=i.item_hash AND a.question_id=? AND a.question_version=?) "
            "ORDER BY i.item_id DESC LIMIT ?",
            (question_id, version, limit),
        ).fetchall()

    def close(self):
        self.db.close()


# --------------------------------------------------------------------------- features for C

_EMPTY_WINDOW = {"items": 0, "count_relevant": 0, "relevance_mass": 0.0, "weighted_sentiment": None,
                 "max_relevance": 0.0}


def _empty_features(decision_time_ms, windows):
    return {"decision_time_ms": decision_time_ms,
            "windows": {name: dict(_EMPTY_WINDOW) for name, _ in windows}}


def news_features(db, decision_time_ms, relevance=RELEVANCE_QUESTION, direction=DIRECTION_QUESTION,
                  windows=FEATURE_WINDOWS):
    """Time-windowed aggregates of the stored analyses known at ``decision_time_ms``.

    Per window (``1h``, ``4h``, by ``received_at``): ``items`` (both answers known), ``count_relevant``
    (P(medium)+P(high) >= 0.5), ``relevance_mass`` (sum of P(medium)+P(high)), ``weighted_sentiment``
    (sum of w*(P(bullish)-P(bearish)) / sum of w with w = P(medium)+P(high); ``None`` when the mass is
    0) and ``max_relevance`` (largest expected relevance value, 0..1). No lookahead: an item needs
    ``received_at <= t`` and both analyses ``done`` with ``analyzed_at <= t``.
    """
    t = int(decision_time_ms)
    out = _empty_features(t, windows)
    oldest = t - max(span for _, span in windows)
    try:
        rows = db.execute(
            "SELECT i.received_at, r.probabilities_json, r.value, d.probabilities_json "
            "FROM paper_futures_news_items i "
            "JOIN paper_futures_news_analysis r ON r.item_hash=i.item_hash AND r.question_id=? "
            "AND r.question_version=? AND r.status='done' AND r.analyzed_at<=? "
            "JOIN paper_futures_news_analysis d ON d.item_hash=i.item_hash AND d.question_id=? "
            "AND d.question_version=? AND d.status='done' AND d.analyzed_at<=? "
            "WHERE i.received_at<=? AND i.received_at>? ORDER BY i.item_id",
            (relevance[0], relevance[1], t, direction[0], direction[1], t, t, oldest),
        ).fetchall()
    except sqlite3.OperationalError:  # no tables yet: nothing is known
        return out
    for name, span in windows:
        weights, signed, values, relevant, count = [], [], [], 0, 0
        for received_at, relevance_json, value, direction_json in rows:
            if received_at <= t - span:
                continue
            relevance_p, direction_p = json.loads(relevance_json), json.loads(direction_json)
            weight = sum(relevance_p.get(option, 0.0) for option in RELEVANT_OPTIONS)
            count += 1
            relevant += 1 if weight >= RELEVANT_THRESHOLD else 0
            weights.append(weight)
            signed.append(weight * (direction_p.get("bullish", 0.0) - direction_p.get("bearish", 0.0)))
            values.append(float(value) if value is not None else 0.0)
        mass = math.fsum(weights)
        out["windows"][name] = {
            "items": count,
            "count_relevant": relevant,
            "relevance_mass": mass,
            "weighted_sentiment": math.fsum(signed) / mass if mass > 0 else None,
            "max_relevance": max(values) if values else 0.0,
        }
    return out


def news_features_at(path, decision_time_ms, **kwargs):
    """``news_features`` over a news DB opened read-only; a missing DB knows nothing."""
    try:
        db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
    except sqlite3.Error:
        return _empty_features(int(decision_time_ms), kwargs.get("windows", FEATURE_WINDOWS))
    try:
        return news_features(db, decision_time_ms, **kwargs)
    finally:
        db.close()


# --------------------------------------------------------------------------- service


def news_state(item):
    """STATE text of one stored item: its sanitized headline and summary, no dates, no source."""
    text = "headline: " + item["title"]
    return text + ("\nsummary: " + item["summary"] if item["summary"] else "")


class NewsService:
    """Poll loop state; ``poll()`` never raises."""

    def __init__(self, store, sources, fetcher, provider=None, questions=None, calibration=None, template=None,
                 probability_source=None, log=print, clock=None, interval_ms=DEFAULT_INTERVAL_MS,
                 retry_window_ms=DEFAULT_RETRY_WINDOW_MS, max_published_age_ms=DEFAULT_MAX_PUBLISHED_AGE_MS,
                 max_analyses_per_poll=DEFAULT_MAX_ANALYSES_PER_POLL, max_attempts=DEFAULT_MAX_ATTEMPTS):
        if interval_ms < MIN_INTERVAL_MS:
            raise ValueError("the polling interval must be at least {} s".format(MIN_INTERVAL_MS // 1000))
        self.store = store
        self.sources = validate_sources(list(sources))
        self.fetcher = fetcher
        self.provider = provider
        self.questions = dict(questions) if questions is not None else load_questions(scope="news")
        self.calibration = calibration if calibration is not None else load_calibration()
        defaults = load_prompt_config()
        self.template = template or defaults["templates"][defaults["default_version"]]
        self.probability_source = probability_source or defaults["probability_source"]
        if self.probability_source not in SOURCE_MODES:
            raise ValueError("unknown probability source {!r}".format(self.probability_source))
        self.log = log
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.interval_ms = interval_ms
        self.retry_window_ms = retry_window_ms
        self.max_published_age_ms = max_published_age_ms
        self.max_analyses_per_poll = max_analyses_per_poll
        self.max_attempts = max_attempts
        self._feeds = {s["id"]: {"next_due": 0, "fails": 0, "etag": None, "last_modified": None, "problem": None}
                       for s in self.sources}
        self._identity = None
        self._model_up = None
        self._problems = {}

    def _problem_once(self, key, message):
        if self._problems.get(key) != message:
            self.log(message)
            self._problems[key] = message

    # -- ingest
    def _ingest(self, now, result):
        for source in self.sources:
            state = self._feeds[source["id"]]
            if now < state["next_due"]:
                continue
            try:
                fetched = self.fetcher.fetch(source["url"], etag=state["etag"], last_modified=state["last_modified"])
                items = [] if fetched.status == 304 else parse_feed(fetched.body, source["url"])
            except (FetchError, FeedError) as error:
                self._source_failed(source, state, now, result, str(error))
                continue
            except Exception as error:  # a source must never stop the others
                self._source_failed(source, state, now, result, "unexpected {}: {}".format(type(error).__name__, error))
                continue
            if state["problem"] is not None:
                self.log("source {} recovered".format(source["id"]))
            state.update(fails=0, problem=None, next_due=now + self.interval_ms,
                         etag=fetched.etag or state["etag"], last_modified=fetched.last_modified or state["last_modified"])
            for raw in items:
                if self._store_item(source, raw, now):
                    result["ingested"] += 1
                else:
                    result["duplicates"] += 1

    def _source_failed(self, source, state, now, result, message):
        state["fails"] += 1
        state["problem"] = message
        state["next_due"] = now + self.interval_ms * min(2 ** state["fails"], MAX_BACKOFF_FACTOR)
        result["failed_sources"].append(source["id"])
        self._problem_once("source " + source["id"], "source {} failed: {}".format(source["id"], message))

    def _store_item(self, source, raw, now):
        title = clean_text(raw["title"], NEWS_CONFIG["max_title_chars"])
        if not title:
            return False
        summary = clean_text(raw["summary"], NEWS_CONFIG["max_summary_chars"])
        url = canonical_url(raw["link"])
        identity = url or str(raw["guid"] or "").strip()
        if not identity:
            return False
        return self.store.add_item({
            "item_hash": item_hash(identity, title), "source_id": source["id"], "source": source["name"],
            "url": url, "title": title, "summary": summary, "published_at": raw["published_ms"],
            "received_at": now, "content_hash": text_hash(title + "\n" + summary),
        }) is not None

    # -- analysis
    def _is_stale(self, row, now):
        _, _, _, _, published_at, received_at = row
        if now - received_at > self.retry_window_ms:
            return True
        return published_at is not None and now - published_at > self.max_published_age_ms

    def _model_down(self, reason):
        if self._model_up is not False:
            self.log("model unavailable: {} (items stay pending while they are inside the retry window)".format(reason))
        self._model_up = False
        self._identity = None

    def _analyze(self, now, result):
        if self.provider is None:
            return
        work = []
        for question in self.questions.values():
            for row in self.store.unresolved(question["id"], question["version"]):
                if self._is_stale(row, now):
                    self.store.append_analysis({
                        "item_hash": row[1], "question_id": question["id"], "question_version": question["version"],
                        "status": "skipped_stale", "analyzed_at": now})
                    result["skipped_stale"] += 1
                else:
                    work.append((row, question))
        # newest items first, an item's questions together (same STATE prefix)
        work.sort(key=lambda pair: (-(min(pair[0][4], pair[0][5]) if pair[0][4] else pair[0][5]), -pair[0][0],
                                    pair[1]["id"], pair[1]["version"]))
        result["pending"] = len(work)
        if not work:
            return
        if not self.provider.health():
            self._model_down("health check failed")
            return
        if self._model_up is False:
            self.log("model available again")
        self._model_up = True
        if self._identity is None:
            self._identity = self.provider.identity()
        ref = self._identity.get("model_ref") or "unknown"
        for row, question in work[: self.max_analyses_per_poll]:
            _, hash_, title, summary, _, _ = row
            base = {"item_hash": hash_, "question_id": question["id"], "question_version": question["version"]}
            prompt = build_prompt(news_state({"title": title, "summary": summary}), question, self.template)
            try:
                done = ask_model(self.provider, prompt, question_letters(question), question,
                                 temperature_for(self.calibration, question["id"], question["version"]),
                                 self.template, self.probability_source)
            except ModelUnavailable as error:
                self._model_down(str(error))
                break
            except ModelResponseError as error:
                self.store.append_error(dict(base, kind=error.kind, message=error, model_ref=ref))
                self.log("error {} {}: {}".format(hash_[:12], question["id"], error.kind))
                if self.store.error_count(hash_, question["id"], question["version"]) >= self.max_attempts:
                    self.store.append_analysis(dict(base, status="failed", analyzed_at=self.clock()))
                    result["pending"] -= 1
                continue
            outcome, output = done["result"], done["output"]
            self.store.append_analysis(dict(
                base, status="done", analyzed_at=self.clock(), question_type=question["type"], model_ref=ref,
                model_info=self._identity, prompt_hash=prompt_hash(prompt, self.template),
                prompt_version=self.template["version"], probability_source=done["source"],
                top_logprobs=output["top_logprobs"], probabilities=outcome["probabilities"],
                temperature=outcome["temperature"], chosen=outcome["chosen"], value=outcome["value"],
                confidence=outcome["confidence"], latency_ms=output.get("latency_ms", 0),
                timings=output.get("timings", {}),
            ))
            result["analyzed"] += 1
            result["pending"] -= 1

    def poll(self):
        """Ingests the due feeds and analyzes the pending items; returns counts and never raises."""
        result = {"ingested": 0, "duplicates": 0, "failed_sources": [], "analyzed": 0, "skipped_stale": 0,
                  "pending": 0}
        try:
            now = self.clock()
            self._ingest(now, result)
            self._analyze(now, result)
        except sqlite3.Error as error:
            self._problem_once("db", "database error: {}".format(error))
        except Exception as error:  # a service must outlive any single failure
            self._problem_once("unexpected", "unexpected error: {}".format(error))
        else:
            self._problems.pop("db", None)
            self._problems.pop("unexpected", None)
        return result

    def close(self):
        pass


# --------------------------------------------------------------------------- cli


def _summary(result):
    line = "news: ingested {ingested} duplicates {duplicates} analyzed {analyzed} skipped_stale {skipped_stale} pending {pending}".format(**result)
    if result["failed_sources"]:
        line += " failed " + ",".join(result["failed_sources"])
    return line


def _env_flag(value):
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def main(argv=None, provider=None, fetcher=None):
    import argparse

    parser = argparse.ArgumentParser(description="Balancita futures news process (N)")
    parser.add_argument("--news-db")
    parser.add_argument("--sources-file", help="default: config/news-sources.json (plus NEWS_EXTRA_RSS_FEEDS)")
    parser.add_argument("--once", action="store_true", help="poll every source once, analyze, and exit")
    parser.add_argument("--analyze", action="store_true",
                        help="ask the local llama-server the news questions (also NEWS_ANALYSIS=1); ingest never needs it")
    parser.add_argument("--features-at", type=int, metavar="MS",
                        help="print the stored features known at this decision time (epoch ms) and exit")
    parser.add_argument("--llama-url", help="default: http://127.0.0.1:$LLAMA_PORT (8088); loopback only")
    parser.add_argument("--interval-seconds", type=float,
                        help="per source poll interval (default: NEWS_POLL_SECONDS or 300; minimum 60)")
    parser.add_argument("--poll-seconds", type=float, default=5.0, help="loop tick")
    parser.add_argument("--fetch-timeout-seconds", type=float, default=DEFAULT_FETCH_TIMEOUT)
    parser.add_argument("--timeout-seconds", type=float, default=30.0, help="per model call")
    parser.add_argument("--retry-window-minutes", type=float, default=DEFAULT_RETRY_WINDOW_MS / MINUTE_MS)
    parser.add_argument("--max-published-age-hours", type=float, default=DEFAULT_MAX_PUBLISHED_AGE_MS / HOUR_MS)
    parser.add_argument("--max-analyses-per-poll", type=int, default=DEFAULT_MAX_ANALYSES_PER_POLL)
    parser.add_argument("--probability-source", choices=SOURCE_MODES)
    parser.add_argument("--prompt-version", type=int)
    parser.add_argument("--prompts-file")
    parser.add_argument("--questions-file")
    parser.add_argument("--calibration-file")
    args = parser.parse_args(argv)
    env = os.environ
    log = lambda line: print(line, flush=True)
    if args.features_at is not None:
        if not args.news_db:
            print("--features-at needs --news-db", file=sys.stderr)
            return 2
        print(json.dumps(news_features_at(args.news_db, args.features_at), sort_keys=True))
        return 0
    if not args.news_db:
        print("--news-db is required", file=sys.stderr)
        return 2
    store = None
    try:
        sources = configured_sources(args.sources_file, env)
        analyze = args.analyze or _env_flag(env.get("NEWS_ANALYSIS"))
        questions = load_questions(args.questions_file, scope="news") if analyze else None
        calibration = load_calibration(args.calibration_file) if analyze else None
        template = mode = None
        if analyze:
            prompts = load_prompt_config(args.prompts_file)
            version = args.prompt_version if args.prompt_version is not None else prompts["default_version"]
            if version not in prompts["templates"]:
                raise ValueError("unknown prompt version {}".format(version))
            template = prompts["templates"][version]
            mode = args.probability_source or prompts["probability_source"]
            if provider is None:
                # Q's provider: refuses any URL that is not loopback, never uses an HTTP proxy.
                provider = LlamaCppProvider(args.llama_url or llama_url(env), model_ref(env), timeout=args.timeout_seconds)
        else:
            provider = None
        interval = args.interval_seconds if args.interval_seconds is not None else float(env.get("NEWS_POLL_SECONDS") or 300)
        if fetcher is None:
            fetcher = UrlFetcher(timeout=args.fetch_timeout_seconds,
                                 user_agent=(env.get("NEWS_USER_AGENT") or "").strip() or DEFAULT_USER_AGENT)
        store = NewsStore(args.news_db, NEWS_CONFIG)
        service = NewsService(
            store, sources, fetcher, provider=provider, questions=questions, calibration=calibration,
            template=template, probability_source=mode, log=log, interval_ms=int(interval * 1000),
            retry_window_ms=int(args.retry_window_minutes * MINUTE_MS),
            max_published_age_ms=int(args.max_published_age_hours * HOUR_MS),
            max_analyses_per_poll=args.max_analyses_per_poll)
    except (OSError, ValueError) as error:
        if store is not None:
            store.close()
        print("configuration error: {}".format(error), file=sys.stderr)
        return 2
    try:
        if args.once:
            print(_summary(service.poll()))
            return 0
        log("news writing to {} (config {}); {} source(s), every {} s; analysis {}".format(
            args.news_db, store.config_hash[:12], len(sources), int(interval),
            "on ({})".format(", ".join(sorted(service.questions))) if provider is not None else "off"))
        while True:
            outcome = service.poll()
            if outcome["ingested"] or outcome["analyzed"] or outcome["skipped_stale"]:
                log(_summary(outcome))
            time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        pass
    finally:
        service.close()
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
