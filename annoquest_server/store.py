"""Files on disk for requests and responses: write-once, append-only, atomic.

Layout under the data directory::

    requests/<request id>.json                      {"request", "by", "at"}       written once (revision 1)
    revisions/<request id>/<NNNNNN>.json              {"request", "by", "at", "revision"}  revisions 2.., each once
    responses/<request id>/<reader key>/<stamp>.json {"responses", "by", "at"}     one file per save
    events/<request id>/<device key>/<stamp>.json    an event batch + "by", "receivedAt"  one file per post

Nothing is ever rewritten, so a backup that keeps one copy per file keeps the whole
history, and the latest state of a reader is the newest file in their folder. Reader
keys are a hash of the identity, so no email address appears in a path; device keys are a
hash of the device id the viewer sends, so its folder name does not give the id away.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def valid_id(request_id: str) -> bool:
    """Whether a request id is safe to use as a file name (and plausibly unguessable)."""
    return bool(ID_PATTERN.match(request_id))


def reader_key(identity: str, salt: str = "") -> str:
    """An opaque, stable folder name for a reader (case-insensitive, salted per data directory)."""
    return hashlib.sha256(f"{salt}:{identity.strip().lower()}".encode("utf-8")).hexdigest()[:16]


def well_formed(responses: object) -> bool:
    """Whether a responses document has the shape merging relies on (the client is not trusted)."""
    if not isinstance(responses, dict):
        return False
    answers, extras, removed = responses.get("answers", {}), responses.get("extras", []), responses.get("removed", [])
    return (
        isinstance(answers, dict)
        and all(isinstance(k, str) and isinstance(a, dict) and isinstance(a.get("rev", 0), int) and isinstance(a.get("at", ""), str) for k, a in answers.items())
        and isinstance(extras, list)
        and all(isinstance(x, dict) and isinstance(x.get("id"), str) for x in extras)
        and isinstance(removed, list)
        and all(isinstance(i, str) for i in removed)
        and isinstance(responses.get("updatedAt", ""), str)
    )


def merge_responses(saves: list[dict]) -> dict | None:
    """Fold a reader's saves into one: per answer the higher (rev, at) wins; extras are
    unioned, minus any id a save removed (the same rules as annoquest's `mergeResponses`).

    Two tabs or two devices each send their whole copy; folding instead of taking the
    newest file means neither erases the other. A malformed save is skipped, never fatal.
    """
    saves = sorted((r for r in saves if well_formed(r)), key=lambda r: r.get("updatedAt") or "")
    if not saves:
        return None
    out = {**saves[-1], "answers": {}, "extras": [], "removed": []}
    removed: set[str] = set()
    extras: dict[str, dict] = {}
    for r in saves:
        for k, a in (r.get("answers") or {}).items():
            cur = out["answers"].get(k)
            if cur is None or (a.get("rev", 0), a.get("at", "")) >= (cur.get("rev", 0), cur.get("at", "")):
                out["answers"][k] = a
        for x in r.get("extras") or []:
            cur = extras.get(x["id"])
            if cur is None or (x.get("rev", 0), x.get("at", "")) >= (cur.get("rev", 0), cur.get("at", "")):
                extras[x["id"]] = x
        removed.update(r.get("removed") or [])
        if r.get("finishedAt") and not out.get("finishedAt"):
            out["finishedAt"] = r["finishedAt"]
    out["extras"] = [x for i, x in extras.items() if i not in removed]
    out["removed"] = sorted(removed)
    return out


EVENT_TYPES = {"open", "view", "visibility", "beat", "answer", "extra", "remove", "name", "finish"}


def well_formed_batch(batch: object, *, max_events: int = 500) -> bool:
    """Whether an event batch has the shape the fold relies on (``EventBatch`` in ``src/spec.ts``)."""
    if not isinstance(batch, dict):
        return False
    events = batch.get("events")
    return (
        all(isinstance(batch.get(k), str) and batch.get(k) for k in ("request", "reader", "device"))
        and len(batch["reader"]) <= 254
        and len(batch["device"]) <= 64
        and isinstance(events, list)
        and 0 < len(events) <= max_events
        and all(
            isinstance(e, dict)
            and e.get("type") in EVENT_TYPES
            and isinstance(e.get("id"), str)
            and isinstance(e.get("session"), str)
            and isinstance(e.get("seq"), int)
            and isinstance(e.get("at"), str)
            for e in events
        )
    )


def _write_once(path: Path, data: dict) -> bool:
    """Write a complete file at `path` only if nothing is there; atomic and exclusive."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    try:
        os.link(tmp, path)  # fails if `path` exists: two concurrent writers cannot both win
        return True
    except FileExistsError:
        return False
    finally:
        tmp.unlink(missing_ok=True)


def _stamp() -> str:
    # Sortable by time; the random tail keeps two saves in one millisecond apart.
    return f"{time.time_ns() // 1_000_000:013d}-{secrets.token_hex(3)}"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@dataclass
class Store:
    """Requests and responses under ``root``."""

    root: Path

    def __post_init__(self) -> None:
        self.root = Path(self.root)

    @property
    def salt(self) -> str:
        p = self.root / "salt"
        if not p.is_file():
            _write_once(p, {"salt": secrets.token_hex(16)})
        return json.loads(p.read_text(encoding="utf-8"))["salt"]

    # ---- requests ----
    def _request_path(self, request_id: str) -> Path:
        return self.root / "requests" / f"{request_id}.json"

    def get_request(self, request_id: str) -> dict | None:
        """The latest revision's record (``{"request", "by", "at", "revision"}``), or None."""
        revs = self.revisions(request_id)
        return revs[-1] if revs else None

    def revisions(self, request_id: str) -> list[dict]:
        """Every stored revision, oldest first; each record carries its ``revision`` number."""
        p = self._request_path(request_id)
        if not p.is_file():
            return []
        first = json.loads(p.read_text(encoding="utf-8"))
        out = [{**first, "revision": 1}]
        d = self.root / "revisions" / request_id
        for f in sorted(d.glob("*.json"), key=lambda f: int(f.stem) if f.stem.isdigit() else 0) if d.is_dir() else []:
            try:
                out.append(json.loads(f.read_text(encoding="utf-8")))
            except ValueError:
                continue
        return out

    def add_revision(self, request: dict, *, by: str | None) -> int:
        """Store a new revision of an existing request; returns its number. Never overwrites."""
        rid = request["id"]
        d = self.root / "revisions" / rid
        for _ in range(20):  # a concurrent writer may take the number: take the next
            # Number from the highest file name, not a count: a damaged file must not block revising.
            taken = [int(f.stem) for f in d.glob("*.json") if f.stem.isdigit()] if d.is_dir() else []
            n = max([1, *taken]) + 1
            path = d / f"{n:06d}.json"
            if _write_once(path, {"request": request, "by": by, "at": _now(), "revision": n}):
                return n
        raise RuntimeError("could not store the revision")

    def put_request(self, request: dict, *, by: str | None) -> bool:
        """Store a request once. Returns False (and changes nothing) if it already exists."""
        return _write_once(self._request_path(request["id"]), {"request": request, "by": by, "at": _now()})

    # ---- responses ----
    def _reader_dir(self, request_id: str, identity: str) -> Path:
        return self.root / "responses" / request_id / reader_key(identity, self.salt)

    def add_responses(self, request_id: str, responses: dict, *, by: str) -> str:
        """Append one save; returns its file name."""
        name = f"{_stamp()}.json"
        _write_once(self._reader_dir(request_id, by) / name, {"responses": {**responses, "by": by}, "by": by, "at": _now()})
        return name

    def _fold(self, d: Path) -> dict | None:
        files = sorted(d.glob("*.json")) if d.is_dir() else []
        saves = []
        for f in files:
            try:
                saves.append(json.loads(f.read_text(encoding="utf-8"))["responses"])
            except (ValueError, KeyError, TypeError):
                continue  # a damaged file must not hide the reader's other saves
        return merge_responses(saves)

    def latest(self, request_id: str, identity: str) -> dict | None:
        """A reader's current answers: all their saves, folded."""
        return self._fold(self._reader_dir(request_id, identity))

    # ---- events ----
    def _device_dir(self, request_id: str, device: str) -> Path:
        return self.root / "events" / request_id / reader_key(f"device:{device}", self.salt)

    def event_files(self, request_id: str, device: str) -> int:
        d = self._device_dir(request_id, device)
        return sum(1 for _ in d.glob("*.json")) if d.is_dir() else 0

    def add_events(self, request_id: str, batch: dict, *, by: str | None) -> str:
        """Append one batch (as sent, plus who the server says sent it); returns its file name."""
        name = f"{_stamp()}.json"
        _write_once(self._device_dir(request_id, batch["device"]) / name, {**batch, **({"by": by} if by else {}), "receivedAt": _now()})
        return name

    def _batches(self, d: Path) -> Iterator[dict]:
        for f in sorted(d.glob("*.json")) if d.is_dir() else []:
            try:
                yield json.loads(f.read_text(encoding="utf-8"))
            except ValueError:
                continue  # a damaged file must not hide the others

    def events(self, request_id: str, *, device: str | None = None, by: str | None = None) -> list[dict]:
        """Stored batches: one device's, or one signed-in user's (all devices), or everything."""
        if device is not None:
            return list(self._batches(self._device_dir(request_id, device)))
        base = self.root / "events" / request_id
        out = [b for d in (sorted(base.iterdir()) if base.is_dir() else []) for b in self._batches(d)]
        return [b for b in out if b.get("by") == by] if by is not None else out

    def request_ids(self) -> list[str]:
        """Every registered request's id."""
        d = self.root / "requests"
        return sorted(f.stem for f in d.glob("*.json") if valid_id(f.stem)) if d.is_dir() else []

    def summary(self, request_id: str) -> dict | None:
        """What a list of requests shows: the latest revision's title and kind, and who sent how much, when."""
        revs = self.revisions(request_id)
        if not revs:
            return None
        req = revs[-1]["request"]
        batches = self.events(request_id)
        readers = {(b.get("by") or "").lower() or b.get("reader") for b in batches}
        received = [b["receivedAt"] for b in batches if b.get("receivedAt")]
        return {
            "id": request_id,
            "title": req.get("title"),
            "kind": "content" if req.get("content") else "guided",
            "content": (req.get("content") or {}).get("url"),
            "items": len(req.get("items") or []),
            "revisions": len(revs),
            "registeredAt": revs[0].get("at"),
            "readers": len(readers - {None}),
            "devices": len({b.get("device") for b in batches}),
            "events": sum(len(b.get("events") or []) for b in batches),
            "lastAt": max(received, default=None),
        }

    def latest_all(self, request_id: str) -> Iterator[dict]:
        base = self.root / "responses" / request_id
        if not base.is_dir():
            return
        for d in sorted(base.iterdir()):
            folded = self._fold(d)
            if folded:
                yield folded
