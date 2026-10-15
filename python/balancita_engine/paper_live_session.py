"""Stage 10B: durable checkpoint of the ingestor, bound to the runner's journal.

``paper_runner.py`` is not touched: this module only reads the runner (``journal.entries``) and writes its own file,
``ingestor-checkpoint.json``, next to the runner's directory contents. Two files cannot be renamed in one atomic step, so
the protocol is an order plus a check:

1. ``poll`` the ingestor, then feed the events to the runner (each one is journaled durably by the runner);
2. only after that, ``save`` the ingestor checkpoint (temp file, ``fsync``, ``os.replace``, directory ``fsync``). The
   file records how long the runner's journal was (``runner_seq``) and its hash at that point.

The ingestor checkpoint is therefore never ahead of the runner. After a crash:

* between 1 and 2 the checkpoint is older than the journal: the ingestor re-reads and re-emits rows the runner already
  has, and the runner rejects them as ``duplicate_event`` (same deterministic ``event_id``);
* during 2 only a temp file exists: the previous checkpoint stands;
* a checkpoint that is damaged, of another schema, or that does not belong to this journal (longer than it, or a
  different hash at ``runner_seq``) is refused with a reason code; nothing is guessed.

No wall clock, no process, no network: the caller decides when to run ``step``.
"""

import json
import os

from .multi_signals import stable_hash
from .paper_live_ingest import Ingestor

CHECKPOINT_FILE = "ingestor-checkpoint.json"
SCHEMA = "balancita-paper-live-ingestor-checkpoint.v1"


class SessionError(Exception):
    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


def _fsync_dir(path):
    fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(directory, ingestor, runner, *, _crash_before_rename=False):
    """Writes the ingestor checkpoint atomically. Call it only after the events of the last poll went through the runner.
    ``_crash_before_rename`` exists for tests: it leaves the temp file and stops, like a crash would."""
    entries = runner.journal.entries
    body = {"schema": SCHEMA, "runner_seq": len(entries), "runner_journal_hash": runner.journal.head,
            "runner_start_hash": entries[0]["hash"], "ingestor": ingestor.checkpoint()}
    text = json.dumps(dict(body, digest=stable_hash(body)), sort_keys=True)
    path = os.path.join(directory, CHECKPOINT_FILE)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    if _crash_before_rename:
        raise SystemError("simulated crash before rename")
    os.replace(tmp, path)
    _fsync_dir(path)
    return body["runner_seq"]


def load(directory, runner):
    """The stored ingestor state, or ``None`` when there is no checkpoint. Refuses anything damaged or foreign."""
    path = os.path.join(directory, CHECKPOINT_FILE)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            stored = json.load(handle)
        body = {k: v for k, v in stored.items() if k != "digest"}
        digest_ok = stable_hash(body) == stored["digest"]
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise SessionError("checkpoint_unreadable", path)
    if not digest_ok:
        raise SessionError("checkpoint_digest_mismatch", path)
    if body.get("schema") != SCHEMA:
        raise SessionError("checkpoint_schema", str(body.get("schema")))
    entries = runner.journal.entries
    at = body["runner_seq"]
    if at > len(entries):
        raise SessionError("checkpoint_ahead_of_runner", "checkpoint at {}, journal has {}".format(at, len(entries)))
    if entries[0]["hash"] != body["runner_start_hash"] or (at and entries[at - 1]["hash"] != body["runner_journal_hash"]):
        raise SessionError("checkpoint_foreign_journal", "the checkpoint does not belong to this journal")
    return body["ingestor"]


def restore(directory, reader, runner, **kw):
    """The ingestor to resume with: from the checkpoint when there is one, else a new one that reads from zero."""
    state = load(directory, runner)
    return Ingestor(reader, **kw) if state is None else Ingestor.from_checkpoint(reader, state, **kw)


def step(directory, ingestor, runner, observed_now_ms):
    """One cycle in the only safe order: poll, feed the runner, then checkpoint the ingestor. Returns the poll result."""
    out = ingestor.poll(observed_now_ms)
    runner.run(out["events"])
    save(directory, ingestor, runner)
    return out
