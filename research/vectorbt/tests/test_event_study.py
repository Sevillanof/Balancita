"""Event study pieces on synthetic prices: no real data, no network, no parquet."""

import math

import numpy as np

from research.vectorbt import event_study as es


def _walk(n, seed, vol=0.0003):
    rng = np.random.default_rng(seed)
    return 90_000 * np.exp(np.cumsum(rng.normal(0, vol, n)))


def test_sigma_is_causal():
    close = _walk(3000, 1)
    sigma = es.ewma_sigma(close)
    changed = close.copy()
    changed[2000:] *= 1.5
    assert np.allclose(sigma[:2000], es.ewma_sigma(changed)[:2000])


def test_events_are_independent_and_signed():
    close = _walk(6000, 2)
    close[4000:] *= 1.02
    sigma = es.ewma_sigma(close)
    events = es.find_events(close, sigma, 5, 60)
    assert any(i in range(4000, 4006) and s == 1.0 for i, s in events)
    idx = [i for i, _ in events]
    assert all(b - a > 60 for a, b in zip(idx, idx[1:]))


def test_forward_return_uses_next_open():
    o = np.array([100.0, 100.0, 110.0, 110.0, 121.0])
    c = np.array([100.0, 100.0, 110.0, 121.0, 121.0])
    assert math.isclose(es.forward_return_bp(o, c, 0, 2, 1.0), 1000.0)
    assert math.isclose(es.forward_return_bp(o, c, 0, 2, -1.0), -1000.0)


def test_controls_match_hour_and_tercile_and_skip_blocked():
    n = 3000
    o = c = _walk(n, 3)
    hours = (np.arange(n) // 60) % 24
    terciles = np.zeros(n, dtype=int)
    blocked = np.zeros(n, dtype=bool)
    blocked[:2000] = True
    rng = np.random.default_rng(0)
    assert es.control_returns(rng, o, c, hours, terciles, 2500, blocked, 5, 1.0) is not None
    blocked[:] = True
    assert es.control_returns(rng, o, c, hours, terciles, 2500, blocked, 5, 1.0) is None


def test_holm_is_monotone_and_bounded():
    adj = es.holm([0.001, 0.04, 0.5, 0.0005])
    assert all(0 <= a <= 1 for a in adj)
    assert adj[3] <= adj[0] <= adj[1] <= adj[2]
    assert math.isclose(adj[3], 0.002)


def test_cluster_by_day_counts_days_not_events():
    mean, se, days = es.cluster_by_day([1.0] * 10 + [3.0] * 10, [0] * 10 + [1] * 10)
    assert days == 2 and math.isclose(mean, 2.0) and se > 0


def test_random_walk_gives_no_signal_and_family_size():
    n = 1440 * 20
    index = np.arange(n, dtype=np.int64) * 60_000
    data = {}
    for k, product in enumerate(("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD")):
        close = _walk(n, 10 + k, vol=0.0004)
        data[product] = es.prepare(index, close, close)
    cells = es.run_family(data, seed=1)
    assert len(cells) == 3 * 3 * 2 * 4 + 3 * 2
    assert not es.verdict(cells, 10.0)["passes"]
