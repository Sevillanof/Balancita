"""Rules engine that catalogues a news item with NO model of any kind (S10, T18 of odd/tasks/noticias-y-auditor.md).

From the headline, the summary and the source id it returns the same card the Qwen cascade used to write: event type,
direction (``bullish`` / ``bearish`` / ``neutral``), strength 0-3 («importancia»: 0 noise, 1 minor, 2 important,
3 very important), the main US-dollar amount and the names of the rules that fired (for the tooltip and the audit).
It is pure and instant: no network, no database, no clock, no randomness; the same text always gives the same card.

The lexicon and every threshold live in ``config/noticias-reglas.json`` (versioned: the card records the version), so
they are tuned by editing that file. The code below only knows the order in which the rules run:

1. a price recap (``recap``) or an opinion (``opinion``) is noise: strength 0, neutral (an opinion may only be lifted to
   ``caps.opinion_max_strength`` by a source prior);
2. the event type, first match wins: hack, network outage, ETF flows, macro / Fed, regulation, hack in the summary,
   adoption, broad macro (markets, politics: ``macro_broad``, noise unless it is a surprise), other;
3. the strength of the type: a hack of >= 100 M US$ is >= 2 and one of >= 1 B is 3 (a follow-up about it stays at 2),
   an outage of an exchange's trading or withdrawals is 2, a macro surprise is 2, ETF flows of >= 500 M are 2,
   enforcement against an exchange is 2, adoption is minor only when it is big or from a known institution;
4. the ``critical`` rules (named patterns read in the headline, or in the headline plus the start of the summary when
   they say ``"where": "text"``: a halted Ethereum mainnet, a stablecoin depeg, the approval of a spot ETF, an
   emergency Fed move, a hack that halts withdrawals) raise the strength and may force the direction;
5. the direction: bearish for a hack or outage (with an amount of at least 1 M US$, an outage word or strength 2),
   ETF flows by their lexicon, the rest by the lexicon only from strength 2;
6. the source priors (``fed`` / ``sec`` primary sources +1, informative sources capped) and the caps.

``strength_base`` is the strength after step 4, before the source priors: it is what the card table stores in
``strength_model`` (the strength before the fixed adjustments).
"""

import json
import os
import re

from . import futures_qwen_noticias as noticias

LEXICON_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config", "noticias-reglas.json"
)
SCHEMA = "balancita-noticias-reglas.v1"
EVENT_TYPES = ("hack", "regulation", "macro_fed", "etf_flows", "network_outage", "adoption", "price_recap", "opinion",
               "other")
DIRECTIONS = ("bullish", "bearish", "neutral")
SUMMARY_CHARS = 240
# What the news store keeps (NEWS_CONFIG): longer text is cut so no pattern can run for long on hostile input.
MAX_TITLE_CHARS = 300
MAX_SUMMARY_CHARS = 1500

_TYPE_LISTS = ("hack", "network_outage", "etf_flows", "macro_fed_title", "regulation", "adoption", "macro_any")
_MODIFIER_LISTS = ("follow_up", "big_words", "macro_surprise", "outage_action", "outage_object", "regulation_action",
                   "regulation_target", "institutions", "purchase_verbs", "purchase_assets")
_AMOUNTS = ("hack_strong", "hack_shock", "hack_direction", "etf_flow_strong", "adoption_minor", "other_minor")
_PRIOR_KEYS = {"boost", "boost_types", "boost_if", "min_strength", "max_strength"}


def _fail(where, message):
    raise ValueError("{}: {}".format(where, message))


def _regex(where, pattern):
    try:
        return re.compile(pattern, re.IGNORECASE)
    except (re.error, TypeError) as error:
        _fail(where, "invalid pattern ({})".format(error))


def _terms(where, value):
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        _fail(where, "must be a non-empty list of strings")
    return value


def _words(where, value):
    """A list of regular expressions as one alternation between word boundaries."""
    return _regex(where, r"\b(?:{})\b".format("|".join(_terms(where, value))))


def _section(data, name):
    value = data.get(name)
    if not isinstance(value, dict):
        _fail(name, "missing or not an object")
    return value


def _strength(where, value):
    if type(value) is not int or not 0 <= value <= 3:
        _fail(where, "must be an integer from 0 to 3")
    return value


class Lexicon:
    """The compiled lexicon. Build it with ``load_lexicon``; it validates everything up front."""

    def __init__(self, data):
        if not isinstance(data, dict):
            _fail("lexicon", "must be an object")
        if data.get("schema") != SCHEMA:
            _fail("schema", "expected {}".format(SCHEMA))
        version = data.get("version")
        if not isinstance(version, str) or not version.strip():
            _fail("version", "must be a non-empty string")
        self.version = version
        recap = _section(data, "recap")
        self.recap_phrases = _words("recap.phrases", recap.get("phrases"))
        assets = "|".join(_terms("recap.assets", recap.get("assets")))
        moves = "|".join(_terms("recap.moves", recap.get("moves")))
        levels = "|".join(_terms("recap.level_words", recap.get("level_words")))
        level = recap.get("price_level")
        self.recap_move = _regex("recap", r"\b(?:{})\s+(?:{})\s.*(?:%|\$\s?\d)".format(assets, moves))
        self.recap_level = _regex(
            "recap.price_level", r"\b(?:{})\b.{{0,50}}?\b(?:{})\b[^$\d]{{0,15}}(?:{})".format(assets, levels, level))
        opinion = _section(data, "opinion")
        self.opinion_question = opinion.get("ends_with_question") is True
        self.opinion_start = _regex(
            "opinion.start_words", r"^(?:{})\b".format("|".join(_terms("opinion.start_words", opinion.get("start_words")))))
        self.opinion_words = _words("opinion.words", opinion.get("words"))
        self.opinion_commentary = _regex("opinion.commentary", "|".join(_terms("opinion.commentary", opinion.get("commentary"))))
        types = _section(data, "types")
        self.types = {name: _words("types." + name, types.get(name)) for name in _TYPE_LISTS}
        direction = _section(data, "direction")
        self.bearish = _words("direction.bearish", direction.get("bearish"))
        self.bullish = _words("direction.bullish", direction.get("bullish"))
        modifiers = _section(data, "modifiers")
        self.modifiers = {name: _words("modifiers." + name, modifiers.get(name)) for name in _MODIFIER_LISTS}
        self.critical = self._critical(data.get("critical"))
        amounts = _section(data, "amounts_usd")
        self.amounts = {}
        for name in _AMOUNTS:
            value = amounts.get(name)
            if type(value) not in (int, float) or isinstance(value, bool) or value <= 0:
                _fail("amounts_usd." + name, "must be a positive number")
            self.amounts[name] = float(value)
        self.priors = self._priors(data.get("source_priors"))
        caps = _section(data, "caps")
        self.opinion_cap = _strength("caps.opinion_max_strength", caps.get("opinion_max_strength"))
        self.recap_cap = _strength("caps.recap_max_strength", caps.get("recap_max_strength"))

    @staticmethod
    def _critical(value):
        if not isinstance(value, list):
            _fail("critical", "must be a list")
        rules, seen = [], set()
        for index, rule in enumerate(value):
            where = "critical[{}]".format(index)
            if not isinstance(rule, dict) or not isinstance(rule.get("name"), str) or not rule["name"]:
                _fail(where, "needs a name")
            if rule["name"] in seen:
                _fail(where, "duplicate name {}".format(rule["name"]))
            seen.add(rule["name"])
            applies = rule.get("applies_to")
            if not isinstance(applies, list) or not applies or not set(applies) <= set(EVENT_TYPES):
                _fail(where, "applies_to must list known event types")
            _strength(where + ".strength", rule.get("strength"))
            if rule.get("direction") not in (None,) + DIRECTIONS:
                _fail(where, "direction must be bullish, bearish or neutral")
            if not isinstance(rule.get("pattern"), str):
                _fail(where, "needs a pattern")
            if rule.get("where", "title") not in ("title", "text"):
                _fail(where, "where must be title or text")
            rules.append({"name": rule["name"], "applies_to": set(applies), "strength": rule["strength"],
                          "direction": rule.get("direction"), "where": rule.get("where", "title"),
                          "regex": _regex(where, rule["pattern"])})
        return rules

    @staticmethod
    def _priors(value):
        if not isinstance(value, dict):
            _fail("source_priors", "must be an object")
        priors = {}
        for source, prior in value.items():
            where = "source_priors." + source
            if not isinstance(prior, dict) or not prior or not set(prior) <= _PRIOR_KEYS:
                _fail(where, "keys must be among {}".format(", ".join(sorted(_PRIOR_KEYS))))
            if "boost" in prior and (type(prior["boost"]) is not int or not 0 <= prior["boost"] <= 3):
                _fail(where + ".boost", "must be an integer from 0 to 3")
            for key in ("min_strength", "max_strength"):
                if key in prior:
                    _strength(where + "." + key, prior[key])
            if "boost_types" in prior and (not isinstance(prior["boost_types"], list)
                                           or not set(prior["boost_types"]) <= set(EVENT_TYPES)):
                _fail(where + ".boost_types", "must list known event types")
            if "boost_if" in prior:
                prior = dict(prior, boost_if=_words(where + ".boost_if", prior["boost_if"]))
            priors[source] = prior
        return priors


_CACHE = {}


def load_lexicon(path=None):
    """The lexicon of ``config/noticias-reglas.json`` (or ``path``), validated and compiled; read once per path.

    A missing or unreadable file raises ``OSError`` and a broken one ``ValueError`` naming the culprit: there is no
    silent default, because a card must say which lexicon made it."""
    path = os.path.abspath(path or LEXICON_PATH)
    if path not in _CACHE:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        _CACHE[path] = Lexicon(data)
    return _CACHE[path]


# --------------------------------------------------------------------------- the rules


def _text(value):
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _event_type(lex, title, summary):
    """``(event_type, rule)``: a recap or an opinion first, then the first type whose words are in the headline."""
    types = lex.types
    if lex.recap_phrases.search(title) or lex.recap_move.search(title) or lex.recap_level.search(title):
        return "price_recap", "recap"
    hack_title, outage_title = types["hack"].search(title), types["network_outage"].search(title)
    commentary = lex.opinion_commentary.search(title)
    if (lex.opinion_question and title.rstrip().endswith("?") or lex.opinion_start.search(title.strip())
            or lex.opinion_words.search(title) or commentary) and (commentary or not hack_title and not outage_title):
        return "opinion", "opinion"
    if hack_title:
        return "hack", None
    if outage_title:
        return "network_outage", None
    if types["etf_flows"].search(title):
        return "etf_flows", None
    if types["macro_fed_title"].search(title):
        return "macro_fed", None
    if types["regulation"].search(title):
        return "regulation", None
    if types["hack"].search(title + " " + summary[:200]):
        return "hack", None
    if types["adoption"].search(title):
        return "adoption", None
    if types["macro_any"].search(title):
        return "macro_fed", "macro_broad"
    return "other", None


def _type_strength(lex, kind, title, amount, rules, broad=False):
    """The strength a type gets from its own words and the amount (step 3)."""
    mods, limit = lex.modifiers, lex.amounts
    if kind in ("price_recap", "opinion"):
        return 0
    if kind == "hack":
        strength = 1
        if amount >= limit["hack_strong"]:
            strength = 2
            rules.append("hack_100m")
        if amount >= limit["hack_shock"]:
            if mods["follow_up"].search(title):
                rules.append("hack_followup_cap")
            else:
                strength = 3
                rules.append("hack_1b")
        return strength
    if kind == "network_outage":
        if mods["outage_action"].search(title) and mods["outage_object"].search(title):
            rules.append("outage_exchange_action")
            return 2
        return 1
    if kind == "macro_fed":
        if mods["macro_surprise"].search(title):
            rules.append("macro_surprise")
            return 2
        return 0 if broad else 1
    if kind == "etf_flows":
        if amount >= limit["etf_flow_strong"]:
            rules.append("etf_flow_500m")
            return 2
        return 1
    if kind == "regulation":
        if mods["regulation_action"].search(title) and mods["regulation_target"].search(title):
            rules.append("regulation_enforcement")
            return 2
        return 1
    if kind == "adoption":
        if amount >= limit["adoption_minor"] or mods["big_words"].search(title) or mods["institutions"].search(title):
            rules.append("adoption_notable")
            return 1
        return 0
    if amount >= limit["other_minor"]:
        rules.append("other_big_amount")
        return 1
    return 0


def _direction(lex, kind, strength, title, amount):
    if strength == 0 or kind in ("price_recap", "opinion"):
        return "neutral"
    if kind in ("hack", "network_outage"):
        outage = lex.types["network_outage"].search(title)
        if amount >= lex.amounts["hack_direction"] or outage or strength >= 2:
            return "bearish"
        return "neutral"
    if strength < 2 and kind != "etf_flows":
        return "neutral"
    bearish, bullish = lex.bearish.search(title), lex.bullish.search(title)
    if bearish and not bullish:
        return "bearish"
    if bullish and not bearish:
        return "bullish"
    return "neutral"


def _source_adjust(lex, source_id, kind, strength, title, rules):
    prior = lex.priors.get(source_id)
    if not prior:
        return strength
    if (prior.get("boost") and (prior.get("boost_types") is None or kind in prior["boost_types"])
            and (prior.get("boost_if") is None or prior["boost_if"].search(title))):
        boosted = min(3, strength + prior["boost"])
        if boosted != strength:
            rules.append("source_boost:" + source_id)
        strength = boosted
    if "min_strength" in prior and strength < prior["min_strength"]:
        strength = prior["min_strength"]
        rules.append("source_floor:" + source_id)
    if "max_strength" in prior and strength > prior["max_strength"]:
        strength = prior["max_strength"]
        rules.append("source_cap:" + source_id)
    return strength


def classify(title, summary="", source_id="", lexicon=None):
    """The card of one item: ``event_type``, ``direction``, ``strength``, ``strength_base``, ``amount_usd``, ``rules``
    and ``lexicon_version``. Never raises on odd input (``None``, numbers, huge text)."""
    lex = lexicon or load_lexicon()
    title, summary, source_id = _text(title)[:MAX_TITLE_CHARS], _text(summary)[:MAX_SUMMARY_CHARS], _text(source_id)
    amount_usd = noticias.parse_amount_usd(title, summary)
    amount = amount_usd or 0.0
    rules = []
    kind, kind_rule = _event_type(lex, title, summary)
    if kind_rule:
        rules.append(kind_rule)
    strength = _type_strength(lex, kind, title, amount, rules, broad=kind_rule == "macro_broad")
    direction_override = None
    text = title + " " + summary[:SUMMARY_CHARS]
    for rule in lex.critical:
        if kind in rule["applies_to"] and rule["regex"].search(text if rule["where"] == "text" else title):
            if rule["strength"] > strength:
                strength = rule["strength"]
            if rule["direction"]:
                direction_override = rule["direction"]
            rules.append(rule["name"])
    strength_base = strength
    strength = _source_adjust(lex, source_id, kind, strength, title, rules)
    if kind == "opinion" and strength > lex.opinion_cap:
        strength = lex.opinion_cap
        rules.append("opinion_cap")
    if kind == "price_recap" and strength > lex.recap_cap:
        strength = lex.recap_cap
        rules.append("recap_cap")
    direction = _direction(lex, kind, strength, title, amount)
    if direction_override and strength > 0 and kind not in ("price_recap", "opinion"):
        direction = direction_override
    return {"event_type": kind, "direction": direction, "strength": strength, "strength_base": strength_base,
            "amount_usd": amount_usd, "rules": rules, "lexicon_version": lex.version}
