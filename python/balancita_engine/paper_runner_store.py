"""Durable pieces of the paper runner (stage 8B): file journal, checkpoint, offset ledger, fault injection.

* ``FileRunnerJournal``: the journal of ``paper_runner`` on disk. One JSON line per entry, hash-chained, ``fsync``
  before an entry counts as written. A final line without a newline is a write that never completed (it was never
  reported durable): it is cut off and the cut is reported. Any other damage refuses the whole file.
* Checkpoint: a small JSON file, versioned and digested, written atomically (temp file, ``fsync``, rename, ``fsync`` of
  the directory) *after* the journal entries it describes are durable. It holds no financial state, only the position
  in the journal and the digests a replay must reproduce. A damaged checkpoint is moved aside (never deleted, never
  overwritten) so the evidence is kept.
* ``OffsetLedger``: for every ``(source, stream, epoch)`` identity (the first argument of every method is the ``(source, stream)`` pair), which offsets were observed, which were processed, the
  highest *contiguous* confirmed offset and the holes. A hole stays a hole until the event arrives or an operator
  declares it (``gap_declared``); a declared gap lets the confirmed offset advance but is never counted as recovered.
* Fault injection (``arm``) to cut the power at precise points, plus the stage 5 faults of ``SignalLog``.

No wall clock, no network, no randomness, no credentials; not connected to anything active.
"""

import fcntl
import json
import os
import shutil

from . import signal_continuity as SC
from .multi_signals import stable_hash

JOURNAL_FILE = "runner-journal.jsonl"
CHECKPOINT_FILE = "runner-checkpoint.json"
SIGNALS_FILE = "signals.jsonl"
QUARANTINE_DIR = "quarantine"
CHECKPOINT_SCHEMA = "balancita-paper-runner-checkpoint.v2"
LOCK_FILE = "runner.lock"
GENESIS = "0" * 64


class StoreError(Exception):
    """The persisted state cannot be trusted. ``reason`` is a stable code; nothing is repaired silently."""

    def __init__(self, reason, detail=""):
        super().__init__("{}: {}".format(reason, detail) if detail else reason)
        self.reason = reason


# ------------------------------------------------------------------------------------------------ fault injection
_FAULTS = []
FAULT_POINTS = ("before_journal", "mid_journal", "after_journal", "after_apply", "before_checkpoint", "mid_checkpoint",
                "after_checkpoint")


def arm(point, nth=1, kind=None):
    """Cuts the power on the ``nth`` time ``point`` is reached (only for journal entries of ``kind`` when given)."""
    if point not in FAULT_POINTS:
        raise ValueError("unknown fault point {!r}".format(point))
    _FAULTS.append({"point": point, "left": nth, "kind": kind})


def disarm():
    del _FAULTS[:]
    SC.disarm()


def due(point, kind=None):
    for fault in list(_FAULTS):
        if fault["point"] == point and fault["kind"] in (None, kind):
            fault["left"] -= 1
            if fault["left"] <= 0:
                _FAULTS.remove(fault)
                return True
    return False


def hit(point, kind=None):
    if due(point, kind):
        raise SC.SimulatedCrash(point)


# ------------------------------------------------------------------------------------------------ the journal
class FileRunnerJournal(object):
    """Same entries as ``paper_runner.RunnerJournal``, on disk. ``entries`` is the in-memory image of the file."""

    def __init__(self, path, entries=None, tail_discarded=0):
        self.path, self.entries, self.head, self.tail_discarded = path, [], GENESIS, tail_discarded
        for entry in entries or ():
            self.entries.append(entry)
            self.head = entry["hash"]

    @classmethod
    def create(cls, path):
        if os.path.exists(path):
            raise StoreError("journal_exists", path)
        with open(path, "w", encoding="utf-8"):
            pass
        return cls(path)

    @classmethod
    def load(cls, path):
        """Reads and verifies the file. Cuts a torn final line; refuses anything else that is wrong."""
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            raise StoreError("journal_missing", path)
        with open(path, "rb") as handle:
            raw = handle.read()
        cut = raw.rfind(b"\n") + 1
        torn = len(raw) - cut
        entries = []
        try:
            for number, line in enumerate(raw[:cut].decode("utf-8").splitlines(), start=1):
                entry = json.loads(line)
                if not isinstance(entry, dict) or entry.get("seq") != number or "hash" not in entry:
                    raise ValueError("line {} is not entry {}".format(number, number))
                entries.append(entry)
        except (ValueError, KeyError, TypeError, UnicodeDecodeError) as error:
            raise StoreError("journal_corrupt", repr(error))
        if not entries:
            raise StoreError("journal_corrupt", "no complete entry")
        prev = GENESIS
        for number, entry in enumerate(entries, start=1):
            body = {k: v for k, v in entry.items() if k != "hash"}
            if body.get("prev") != prev or stable_hash(body) != entry["hash"]:
                raise StoreError("journal_corrupt", "hash chain broken at entry {}".format(number))
            prev = entry["hash"]
        if torn:
            with open(path, "r+b") as handle:      # drop the torn bytes so the next append starts on a clean line
                handle.truncate(cut)
                handle.flush()
                os.fsync(handle.fileno())
        return cls(path, entries, torn)

    def add(self, t_ms, kind, data):
        body = {"seq": len(self.entries) + 1, "t_ms": int(t_ms), "kind": kind, "data": SC._plain(data), "prev": self.head}
        body["hash"] = stable_hash(body)
        line = (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        hit("before_journal", kind)
        with open(self.path, "ab") as handle:
            if due("mid_journal", kind):
                handle.write(line[: len(line) // 2])      # a torn write, as a power cut leaves it
                handle.flush()
                os.fsync(handle.fileno())
                raise SC.SimulatedCrash("mid_journal")
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
        self.entries.append(body)
        self.head = body["hash"]
        hit("after_journal", kind)
        return body


# ------------------------------------------------------------------------------------------------ the checkpoint
def write_checkpoint(path, body):
    """Atomic: nothing but a complete, digested file ever appears under ``path``."""
    text = json.dumps(dict(body, schema=CHECKPOINT_SCHEMA, digest=stable_hash(dict(body, schema=CHECKPOINT_SCHEMA))),
                      sort_keys=True, indent=1)
    hit("before_checkpoint")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    if due("mid_checkpoint"):
        raise SC.SimulatedCrash("mid_checkpoint")         # temp file written, never renamed: the old checkpoint stands
    os.replace(tmp, path)
    directory = os.path.dirname(os.path.abspath(path))
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    hit("after_checkpoint")


def read_checkpoint(path):
    """The checkpoint body, ``None`` when there is none. Anything unreadable, undigested or of another schema raises."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            stored = json.load(handle)
        body = {k: v for k, v in stored.items() if k != "digest"}
        if stable_hash(body) != stored["digest"]:
            raise ValueError("digest mismatch")
    except (ValueError, KeyError, TypeError, UnicodeDecodeError) as error:
        raise StoreError("corrupt_checkpoint", str(error))
    if body.get("schema") != CHECKPOINT_SCHEMA:
        raise StoreError("checkpoint_incompatible", str(body.get("schema")))
    for field in ("upto_seq", "journal_hash", "manifest_hash", "engine_behavior_id", "state_digest"):
        if field not in body:
            raise StoreError("checkpoint_incompatible", "missing " + field)
    if not isinstance(body["upto_seq"], int) or body["upto_seq"] < 1:
        raise StoreError("corrupt_checkpoint", "bad position")
    return body


def quarantine(directory, path, reason):
    """Copies a damaged file aside as evidence (the original stays where it is). Returns the new path."""
    target_dir = os.path.join(directory, QUARANTINE_DIR)
    os.makedirs(target_dir, exist_ok=True)
    with open(path, "rb") as handle:
        digest = stable_hash(handle.read().decode("latin-1"))[:12]
    target = os.path.join(target_dir, "{}.{}.{}".format(os.path.basename(path), reason, digest))
    shutil.copy2(path, target)
    return target


# ------------------------------------------------------------------------------------------------ offsets
def _merge(ranges):
    ranges = sorted(ranges)
    out = []
    for lo, hi in ranges:
        if out and lo <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


# ------------------------------------------------------------------------------------------------ single writer
class DirectoryLock(object):
    """Exclusive, non-blocking ``flock`` on ``<dir>/runner.lock`` for the whole life of a runner. The kernel drops it when
    the process dies (even abruptly), so a crash never leaves a stale lock. A second opener fails with ``directory_locked``
    *before* it reads, truncates, quarantines or appends anything."""

    def __init__(self, directory):
        os.makedirs(directory, exist_ok=True)
        self.path = os.path.join(directory, LOCK_FILE)
        self.handle = open(self.path, "a+b")
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (IOError, OSError):
            self.handle.close()
            self.handle = None
            raise StoreError("directory_locked", "another process (or runner) writes in " + directory)

    def release(self):
        if self.handle is not None:
            self.handle.close()          # closing the descriptor releases the flock
            self.handle = None


def _label(line, epoch):
    return "{}|{}#{}".format(line[0], line[1], epoch)


class OffsetLedger(object):
    """Per ``(source, stream, epoch)``: what was observed, what was processed, what is confirmed and what is missing.

    * observed: the highest offset seen at all (it says nothing about continuity);
    * processed: offsets whose event is durably in the journal (accepted or rejected) and whose obligations are closed;
    * contiguous: the highest offset ``c`` such that every offset from the first one observed up to ``c`` is processed or
      covered by a declared gap. This is the only value that may be confirmed to a producer;
    * holes: offsets between the first and the highest observed that are neither processed nor declared;
    * declared gaps: an operator's durable statement that a range will not arrive. They let ``contiguous`` advance;
      they never make the missing events "recovered" and are always reported separately.
    A stream that restarts its numbering must say so with a higher ``epoch``; an older one is refused."""

    def __init__(self):
        self.streams = {}
        self.max_epoch = {}
        self.owners = {}      # (line, epoch, offset) -> event_id that took the offset

    def _stream(self, line, epoch):
        return self.streams.setdefault((line, epoch), {"base": None, "observed": None, "processed": [], "declared": []})

    def stale_epoch(self, line, epoch):
        return epoch < self.max_epoch.get(line, epoch)

    def reused(self, line, epoch, offset, event_id):
        owner = self.owners.get((line, epoch, offset))
        return owner is not None and owner != event_id

    def observe(self, line, epoch, offset, event_id):
        self.max_epoch[line] = max(epoch, self.max_epoch.get(line, epoch))
        stream = self._stream(line, epoch)
        stream["base"] = offset if stream["base"] is None else min(stream["base"], offset)
        stream["observed"] = offset if stream["observed"] is None else max(stream["observed"], offset)
        self.owners.setdefault((line, epoch, offset), event_id)

    def process(self, line, epoch, offset):
        stream = self._stream(line, epoch)
        stream["processed"] = _merge(stream["processed"] + [[offset, offset]])

    def declare(self, line, epoch, lo, hi, reason, evidence, operator, t_ms):
        stream = self._stream(line, epoch)
        stream["declared"].append({"from": lo, "to": hi, "reason": reason, "evidence": evidence, "operator": operator,
                                   "t_ms": t_ms})

    def _covered(self, stream):
        return _merge(stream["processed"] + [[g["from"], g["to"]] for g in stream["declared"]])

    def missing(self, line, epoch):
        """Ranges between the first and the highest observed offset that are neither processed nor declared."""
        stream = self.streams.get((line, epoch))
        if not stream or stream["base"] is None:
            return []
        out, cursor = [], stream["base"]
        for lo, hi in self._covered(stream):
            if hi < cursor:
                continue
            if lo > cursor:
                out.append([cursor, min(lo - 1, stream["observed"])])
            cursor = max(cursor, hi + 1)
        if cursor <= stream["observed"]:
            out.append([cursor, stream["observed"]])
        return [r for r in out if r[0] <= r[1]]

    def contiguous(self, line, epoch):
        stream = self.streams.get((line, epoch))
        if not stream or stream["base"] is None:
            return None
        for lo, hi in self._covered(stream):
            if lo <= stream["base"] <= hi:
                return hi
        return None

    def confirmable(self):
        """What may be acknowledged to each producer: ``{"source|stream#epoch": highest contiguous offset}``."""
        return {_label(s, e): self.contiguous(s, e) for (s, e) in sorted(self.streams)}

    def summary(self):
        out = {}
        for (line, epoch) in sorted(self.streams):
            stream = self.streams[(line, epoch)]
            out[_label(line, epoch)] = {
                "first": stream["base"], "observed": stream["observed"], "processed": stream["processed"],
                "contiguous": self.contiguous(line, epoch), "holes": self.missing(line, epoch),
                "declared_gaps": stream["declared"]}
        return out

    def holes_count(self):
        return sum(len(self.missing(s, e)) for (s, e) in self.streams)
