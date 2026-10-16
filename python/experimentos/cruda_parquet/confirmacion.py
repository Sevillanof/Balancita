"""Reference derivation over CONFIRMED records only, contrasted with the path that consumes pending ones (issue #248, BAL-REV-183-DURABILIDAD-09).

Two words used with care here:

* ``confirmed`` = the block holding the record was sealed AND its manifest line was fsynced (the writer's own definition). This is a LOGICAL
  confirmation. Whether the bytes survive a power loss or a controller that lies about ``fsync`` is NOT demonstrated by anything in this
  experiment.
* ``pending`` = accepted by the writer but not yet confirmed. A consumer that acts on pending records (what the live path does today with
  its own memory) can act on messages that a crash then loses.

``compare_paths`` labels the difference; it does not choose a sync frequency or an acceptable loss window.
"""
from __future__ import annotations

from typing import Iterable

from experimentos.cruda_parquet.derivacion import derivation_hash, derive_minutes


def identity(r) -> tuple:
    return (r.epoch, r.arrival_no)


def compare_paths(consumed: Iterable, confirmed: Iterable) -> dict:
    """``consumed``: every record a pending-consuming path saw, in arrival order. ``confirmed``: what the archive holds after recovery.

    The result never says "reproducible from the archive" for the pending path: ``reproducible_from_archive`` is True only when no consumed
    record is missing from the confirmed ones (nothing was lost) and the two derivations are equal.
    """
    consumed_list = list(consumed)
    confirmed_ids = {identity(r) for r in confirmed}
    confirmed_list = [r for r in consumed_list if identity(r) in confirmed_ids]
    lost = [r for r in consumed_list if identity(r) not in confirmed_ids]
    extra = len(confirmed_ids) - len(confirmed_list)
    from_pending = derive_minutes(consumed_list)
    from_confirmed = derive_minutes(confirmed_list)
    differing = sorted({m for part in ("live", "recovered") for m in set(from_pending[part]) | set(from_confirmed[part])
                        if from_pending[part].get(m) != from_confirmed[part].get(m)})
    equal = derivation_hash(from_pending) == derivation_hash(from_confirmed)
    return {
        "consumed": len(consumed_list), "confirmed": len(confirmed_list), "lost_pending": len(lost),
        "first_lost": list(identity(lost[0])) if lost else None, "last_lost": list(identity(lost[-1])) if lost else None,
        "confirmed_not_consumed": extra, "differing_minutes_count": len(differing), "differing_minutes_first": differing[:5], "derivations_equal": equal,
        "reproducible_from_archive": not lost and extra == 0 and equal,
        "label": "pending path diverges: decisions consumed %d record(s) the archive does not hold" % len(lost) if lost else "no divergence in this run",
        "physical_durability": "not demonstrated (no power-loss or fsync-lie test)",
    }
