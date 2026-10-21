import os
import sqlite3

import pytest

from research.vectorbt import trial_ledger as tl

STRATEGY = "c27-breakout-perp-v1"
FAMILY = "c27-breakout-perp"


def _fill(ledger, n=9, strategy=STRATEGY):
    return [ledger.record_run(experiment_id="exp-{}".format(i), source_strategy_id=strategy,
                              params={"window": 10 + i, "stop": 0.01}) for i in range(n)]


def test_nine_configurations_are_nine_variants_and_nine_runs(tmp_path):
    with tl.Ledger(str(tmp_path / "l.sqlite")) as ledger:
        _fill(ledger)
        assert ledger.distinct_variants(FAMILY) == 9
        assert len(ledger.runs(FAMILY)) == 9


def test_repeating_a_configuration_is_a_new_run_not_a_new_variant(tmp_path):
    with tl.Ledger(str(tmp_path / "l.sqlite")) as ledger:
        _fill(ledger)
        ledger.record_run(experiment_id="again", source_strategy_id=STRATEGY, params={"stop": 0.01, "window": 10})
        assert len(ledger.runs(FAMILY)) == 10
        assert ledger.distinct_variants(FAMILY) == 9


def test_renaming_the_version_keeps_the_family_and_the_history(tmp_path):
    with tl.Ledger(str(tmp_path / "l.sqlite")) as ledger:
        _fill(ledger)
        ledger.record_run(experiment_id="v2", source_strategy_id="c27-breakout-perp-v2",
                          params={"window": 10, "stop": 0.01})
        assert ledger.distinct_variants(FAMILY) == 9
        assert len(ledger.runs(FAMILY)) == 10
        assert ledger.runs(FAMILY)[-1]["family"] == FAMILY


def test_update_and_delete_abort(tmp_path):
    path = str(tmp_path / "l.sqlite")
    with tl.Ledger(path) as ledger:
        _fill(ledger, 1)
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            ledger.conn.execute("UPDATE trials SET status='error'")
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            ledger.conn.execute("DELETE FROM trials")
        assert len(ledger.runs(FAMILY)) == 1


def test_selection_is_a_new_row_and_does_not_add_a_variant(tmp_path):
    with tl.Ledger(str(tmp_path / "l.sqlite")) as ledger:
        ids = _fill(ledger, 2)
        ledger.record_selection(ids[0])
        assert ledger.distinct_variants(FAMILY) == 2
        assert len(ledger.runs(FAMILY)) == 2
        assert ledger.conn.execute("SELECT COUNT(*) FROM trials WHERE selected_for_gate=1").fetchone()[0] == 1


def test_read_only_count_does_not_write_and_handles_missing_file(tmp_path):
    path = str(tmp_path / "l.sqlite")
    assert tl.count_distinct_variants(path, FAMILY) == 0
    assert not os.path.exists(path)
    with tl.Ledger(path) as ledger:
        _fill(ledger, 3)
    before = (os.stat(path).st_mtime_ns, open(path, "rb").read())
    assert tl.count_distinct_variants(path, FAMILY) == 3
    assert (os.stat(path).st_mtime_ns, open(path, "rb").read()) == before
    with pytest.raises(sqlite3.OperationalError):
        tl._readonly(path).execute("DELETE FROM trials")
