"""The server owner's commands, run where the data directory is (e.g. ``ssh <host> python -m annoquest_server …``).

    python -m annoquest_server link <url> [--reader ID] [--viewer URL]   a content link for any page
    python -m annoquest_server put-request <request.json>                register a request (write-once)
    python -m annoquest_server events <request id>                       its event batches, as JSON (for `annoquest export`)

The data directory is ``$ANNOQUEST_SERVER_DATA_DIR`` (else ``~/.local/share/annoquest/server``),
the same one the app uses; ``--data-dir`` overrides it. Output is JSON, errors exit non-zero.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .content import content_link, load_secret, origin_of
from .store import Store, valid_id
from .web import default_data_dir


def _out(value) -> None:
    sys.stdout.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m annoquest_server", description=__doc__.splitlines()[0])
    p.add_argument("--data-dir", default=None, help="the app's data directory")
    sub = p.add_subparsers(dest="cmd", required=True)
    lk = sub.add_parser("link", help="a content link for a page (its site's token included)")
    lk.add_argument("url")
    lk.add_argument("--reader", default=None, help="the reader's id (else each browser gets its own)")
    lk.add_argument("--viewer", default=os.environ.get("ANNOQUEST_VIEWER_URL", ""), help="where the viewer is served (default: $ANNOQUEST_VIEWER_URL)")
    pr = sub.add_parser("put-request", help="register a request (a file, or - for stdin)")
    pr.add_argument("file")
    ev = sub.add_parser("events", help="a request's event batches")
    ev.add_argument("request_id")
    a = p.parse_args(argv)
    root = Path(a.data_dir) if a.data_dir else default_data_dir()

    if a.cmd == "link":
        if origin_of(a.url) is None:
            p.error(f"not an http(s) URL: {a.url}")
        if not a.viewer:
            p.error("say where the viewer is: --viewer https://example.org/annoquest/ (or set ANNOQUEST_VIEWER_URL)")
        _out({"link": content_link(load_secret(root), a.url, viewer=a.viewer, reader=a.reader), "content": a.url, "reader": a.reader})
        return 0
    if a.cmd == "put-request":
        data = json.loads(sys.stdin.read() if a.file == "-" else Path(a.file).read_text(encoding="utf-8"))
        rid = data.get("id") if isinstance(data, dict) else None
        if not rid or not valid_id(rid) or data.get("schema", "annoquest/request") != "annoquest/request":
            p.error("not an annoquest request with a valid id (run `annoquest create` on it first)")
        data = {**data, "schema": "annoquest/request"}
        store = Store(root)
        if store.get_request(rid):
            same = json.dumps({k: v for k, v in store.get_request(rid)["request"].items() if k != "revision"}, sort_keys=True) == json.dumps(data, sort_keys=True)
            n = store.get_request(rid)["revision"] if same else store.add_revision(data, by="owner")
            _out({"id": rid, "created": False, "revision": n})
        else:
            store.put_request(data, by="owner")
            _out({"id": rid, "created": True, "revision": 1})
        return 0
    if a.cmd == "events":
        if not valid_id(a.request_id):
            p.error("not a request id")
        _out({"request": a.request_id, "batches": Store(root).events(a.request_id)})
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
