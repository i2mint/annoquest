"""Files on disk for requests and responses: write-once, append-only, atomic.

Layout under the data directory::

    requests/<request id>.json                      {"request", "by", "at"}       written once
    responses/<request id>/<reader key>/<stamp>.json {"responses", "by", "at"}     one file per save

Nothing is ever rewritten, so a backup that keeps one copy per file keeps the whole
history, and the latest state of a reader is the newest file in their folder. Reader
keys are a hash of the identity, so no email address appears in a path.
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


def merge_responses(saves: list[dict]) -> dict | None:
    """Fold a reader's saves into one: per answer the higher (rev, at) wins; extras are unioned.

    Two tabs or two devices each send their whole copy; folding instead of taking the
    newest file means neither erases the other.
    """
    if not saves:
        return None
    saves = sorted(saves, key=lambda r: r.get("updatedAt") or "")
    out = {**saves[-1], "answers": {}, "extras": []}
    seen: set[str] = set()
    for r in saves:
        for k, a in (r.get("answers") or {}).items():
            cur = out["answers"].get(k)
            if cur is None or (a.get("rev", 0), a.get("at", "")) >= (cur.get("rev", 0), cur.get("at", "")):
                out["answers"][k] = a
        for x in r.get("extras") or []:
            if x.get("id") not in seen:
                seen.add(x.get("id"))
                out["extras"].append(x)
        if r.get("finishedAt") and not out.get("finishedAt"):
            out["finishedAt"] = r["finishedAt"]
    return out


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
        p = self._request_path(request_id)
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None

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
        return merge_responses([json.loads(f.read_text(encoding="utf-8"))["responses"] for f in files])

    def latest(self, request_id: str, identity: str) -> dict | None:
        """A reader's current answers: all their saves, folded."""
        return self._fold(self._reader_dir(request_id, identity))

    def latest_all(self, request_id: str) -> Iterator[dict]:
        base = self.root / "responses" / request_id
        if not base.is_dir():
            return
        for d in sorted(base.iterdir()):
            folded = self._fold(d)
            if folded:
                yield folded
