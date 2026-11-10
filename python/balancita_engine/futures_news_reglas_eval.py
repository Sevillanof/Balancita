"""Agreement of the rules engine with reference labels (informative only; S10, T18).

The reference is the Haiku card of ``analisis/clasificador-noticias/datos.jsonl`` (``etiqueta``: event type, strength,
direction). Agreement is not accuracy: Haiku is not the truth, and against itself it agrees ~93 % on strength, ~97 % on
direction and ~91 % on type (``analisis/clasificador-noticias/informe.md``).

The file is split at ``--corte-ms`` (default 2026-11-07 00:00 UTC): the lexicon is tuned looking ONLY at the rows
before it (``desarrollo``); the rows from it on (``prueba``) are the final test and are never used to tune. The
command prints both so nobody has to guess, and the test split is meant to be read once, at the end.

    PYTHONPATH=python python3 -m balancita_engine.futures_news_reglas_eval datos.jsonl [--json]
"""

import argparse
import json
import sys

from . import futures_news_reglas as reglas

CORTE_MS = 1_794_009_600_000  # 2026-11-07 00:00:00 UTC: from here on = final test split


def bucket(strength):
    """Strength 0-3 as the three groups the comparison uses: 0, 1 and 2-3."""
    return 0 if strength == 0 else 1 if strength == 1 else 2


def _pct(part, whole):
    return None if not whole else round(100.0 * part / whole, 1)


def agreement(rows, classify=reglas.classify):
    """Agreement of ``classify`` with the ``etiqueta`` of each row (``title``, ``summary``, ``source_id``)."""
    count = exact_strength = same_bucket = same_direction = same_type = 0
    baseline_neutral = true_pos = marked = reference_pos = 0
    bearish_hit = bearish_ref = bullish_hit = bullish_ref = 0
    confusion = {}
    for row in rows:
        ref = row["etiqueta"]
        card = classify(row.get("title"), row.get("summary"), row.get("source_id"))
        count += 1
        exact_strength += card["strength"] == ref["strength"]
        same_bucket += bucket(card["strength"]) == bucket(ref["strength"])
        same_direction += card["direction"] == ref["direction"]
        same_type += card["event_type"] == ref["event_type"]
        baseline_neutral += ref["direction"] == "neutral"
        reference_pos += ref["strength"] >= 2
        marked += card["strength"] >= 2
        true_pos += ref["strength"] >= 2 and card["strength"] >= 2
        bearish_ref += ref["direction"] == "bearish"
        bearish_hit += ref["direction"] == "bearish" and card["direction"] == "bearish"
        bullish_ref += ref["direction"] == "bullish"
        bullish_hit += ref["direction"] == "bullish" and card["direction"] == "bullish"
        key = "{}>{}".format(bucket(ref["strength"]), bucket(card["strength"]))
        confusion[key] = confusion.get(key, 0) + 1
    return {
        "n": count,
        "strength_exact_pct": _pct(exact_strength, count),
        "strength_bucket_pct": _pct(same_bucket, count),
        "direction_pct": _pct(same_direction, count),
        "direction_always_neutral_pct": _pct(baseline_neutral, count),
        "type_pct": _pct(same_type, count),
        "reference_strength_2_3": reference_pos,
        "marked_strength_2_3": marked,
        "recall_2_3": [true_pos, reference_pos],
        "precision_2_3": [true_pos, marked],
        "bearish_recall": [bearish_hit, bearish_ref],
        "bullish_recall": [bullish_hit, bullish_ref],
        "confusion_reference_to_rules": dict(sorted(confusion.items())),
    }


def split(rows, corte_ms=CORTE_MS):
    development = [row for row in rows if row["received_at"] < corte_ms]
    test = [row for row in rows if row["received_at"] >= corte_ms]
    return development, test


def load_rows(path):
    with open(path, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    return [row for row in rows if isinstance(row.get("etiqueta"), dict)]


def _line(name, report):
    def frac(pair):
        return "{}/{}".format(*pair)

    return ("{name}: n={n} strength(0/1/2-3)={b}% exact={e}% direction={d}% (always neutral {base}%) type={t}% "
            "recall(2-3)={rec} precision(2-3)={pre} bearish={bear} bullish={bull}").format(
        name=name, n=report["n"], b=report["strength_bucket_pct"], e=report["strength_exact_pct"],
        d=report["direction_pct"], base=report["direction_always_neutral_pct"], t=report["type_pct"],
        rec=frac(report["recall_2_3"]), pre=frac(report["precision_2_3"]), bear=frac(report["bearish_recall"]),
        bull=frac(report["bullish_recall"]))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Agreement of the news rules engine with reference labels")
    parser.add_argument("labels", help="jsonl with title, summary, source_id, received_at and etiqueta")
    parser.add_argument("--corte-ms", type=int, default=CORTE_MS, help="first received_at (ms) of the final test split")
    parser.add_argument("--lexicon", help="default: config/noticias-reglas.json")
    parser.add_argument("--solo-desarrollo", action="store_true",
                        help="print only the development split (use while tuning: the test split is read once)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    lexicon = reglas.load_lexicon(args.lexicon)

    def classify(title, summary, source_id):
        return reglas.classify(title, summary, source_id, lexicon=lexicon)

    development, test = split(load_rows(args.labels), args.corte_ms)
    reports = {"lexicon_version": lexicon.version, "desarrollo": agreement(development, classify)}
    if not args.solo_desarrollo:
        reports["prueba"] = agreement(test, classify)
    if args.json:
        print(json.dumps(reports, sort_keys=True, indent=1))
    else:
        print("lexicon {}".format(lexicon.version))
        for name in ("desarrollo", "prueba"):
            if name in reports:
                print(_line(name, reports[name]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
