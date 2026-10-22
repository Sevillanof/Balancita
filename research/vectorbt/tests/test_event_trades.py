"""Event export on synthetic prices: no network, no parquet."""

import math
import os
import subprocess

import numpy as np

from research.vectorbt import event_study as es
from research.vectorbt import event_trades as et

HERE = os.path.dirname(os.path.abspath(__file__))
MINUTE = 60_000
T0 = 1_740_787_200_000


def _market(n, seed, jump_at=None, scale=1.0):
    rng = np.random.default_rng(seed)
    c = 90_000 * scale * np.exp(np.cumsum(rng.normal(0, 0.0003, n)))
    for k, at in enumerate(jump_at or ()):
        c[at:] *= 1.02 if k % 2 == 0 else 0.98
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) * 1.0002
    l = np.minimum(o, c) * 0.9998
    index = T0 + np.arange(n, dtype=np.int64) * MINUTE
    return index, o, h, l, c


def _bundle(n=8000, seed=1, jumps=(3000, 5000, 6500), funding=True, scale=1.0):
    index, o, h, l, c = _market(n, seed, jumps, scale)
    fund = [(T0 + k * 3_600_000, T0 + (k + 1) * 3_600_000, 0.0001) for k in range(n // 60 + 2)] if funding else []
    return es.prepare(index, o, c), {"index": index, "o": o, "h": h, "l": l, "c": c, "funding": fund}


def _payload(funding=True):
    data, extras = {}, {}
    for k, product in enumerate(("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD")):
        data[product], extras[product] = _bundle(seed=1 + k, funding=funding, scale=1.0 + k)
    # same jumps so the leader events exist in every product
    window = ["2025-03-01T00:00:00Z", "2025-03-06T13:20:00Z"]
    return data, extras, et.build_payload(data, extras, window, "2026-01-01T00:00:00Z")


def test_handmade_series_values():
    n = 200
    index = T0 + np.arange(n, dtype=np.int64) * MINUTE
    o = np.full(n, 100.0)
    c = np.full(n, 100.0)
    h = np.full(n, 100.0)
    l = np.full(n, 100.0)
    o[11], c[11] = 100.0, 100.0
    h[12], l[13] = 101.0, 98.0
    c[15] = 102.0       # horizon 5 closes at bar 15
    c[70] = 90.0        # horizon 60 closes at bar 70
    extra = {"index": index, "o": o, "h": h, "l": l, "c": c,
             "funding": [(T0, T0 + 10 * 3_600_000, 0.0001)]}
    out = et.event_horizons(extra, 10)
    assert math.isclose(out["5"]["r"], 200.0)
    assert math.isclose(out["5"]["up"], 100.0)
    assert math.isclose(out["5"]["dn"], -200.0)
    assert math.isclose(out["60"]["r"], -1000.0)
    # 5 minutes held at 1 bp/hour of rate: 5/60 * 1 bp
    assert math.isclose(out["5"]["f"], round(5 / 60, 2), abs_tol=0.005)
    assert math.isclose(out["60"]["f"], 1.0)
    assert et.event_horizons(extra, 190) is None


def test_no_funding_gives_zero_and_incomplete():
    data, extras, payload = _payload(funding=False)
    assert payload["funding_complete"] is False
    ev = next(e for lst in payload["events"].values() for e in lst)
    assert all(v["f"] == 0 for v in ev["h"].values())


def test_schema_shape_and_78_cells():
    data, extras, payload = _payload()
    assert payload["schema"] == "balancita.analyzer-events.v1"
    assert payload["horizons"] == [5, 15, 30, 60]
    assert payload["funding_complete"] is True
    assert len(payload["cells"]) == 78
    assert len({c["id"] for c in payload["cells"]}) == 78
    assert set(payload["round_trip_cost_bp"]) == {"PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"}
    expected = {"{}|move|{}".format(p, w) for p in data for w in (5, 15, 60)}
    expected |= {"PF_ETHUSD|leader|15", "PF_SOLUSD|leader|15"}
    assert set(payload["events"]) == expected
    cell = payload["cells"][0]
    assert {"id", "kind", "product", "window", "direction", "horizon", "events", "events_exported", "gross_bp",
            "excess_bp", "ic90_low_bp", "p_holm"} <= set(cell)
    assert cell["id"] == "move|PF_XBTUSD|5|follow|5"


def test_events_complete_and_independent():
    data, extras, payload = _payload()
    assert sum(len(v) for v in payload["events"].values()) > 0
    for key, events in payload["events"].items():
        ts = [e["t"] for e in events]
        assert all(b - a > 60 * MINUTE for a, b in zip(ts, ts[1:])), key
        for e in events:
            assert e["s"] in (1, -1)
            assert set(e["h"]) == {"5", "15", "30", "60"}
            for v in e["h"].values():
                assert set(v) == {"r", "up", "dn", "f"}
                assert v["up"] >= v["dn"]
    for cell in payload["cells"]:
        key = "{}|{}|{}".format(cell["product"], cell["kind"], cell["window"])
        assert cell["events_exported"] == len(payload["events"][key])


def test_gross_matches_family_when_all_events_have_control():
    data, extras, payload = _payload()
    cell = next(c for c in payload["cells"] if c["id"] == "move|PF_XBTUSD|5|follow|5")
    evs = payload["events"]["PF_XBTUSD|move|5"]
    if evs and cell["events"] == len(evs):
        mean = sum(e["s"] * e["h"]["5"]["r"] for e in evs) / len(evs)
        assert abs(mean - cell["gross_bp"]) < 0.05


def test_event_study_untouched():
    """No uncommitted change to event_study.py (the branch diff against main is checked in review)."""
    root = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
    done = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", "research/vectorbt/event_study.py"], cwd=root,
                          capture_output=True)
    assert done.returncode == 0
