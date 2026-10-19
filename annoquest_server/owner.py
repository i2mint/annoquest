"""The owner's app: list requests, read every reader's events, make content links.

A second app over the reader app's data directory, meant to sit behind the platform's
sign-in with the owner as its only allowed user (on enlace: ``access = "protected:user"``
and ``allowed_users``). Access is decided per app on such a platform, which is why this is
not a mode of the public reader app: every caller of this app is the owner. For defence in
depth, given ``owners`` and an ``identity`` function, a caller who is not an owner is refused
(so a manifest that forgot the gate fails closed); with no ``owners``, the gate is trusted.

It only reads (requests, events) and signs (links): readers write, the owner reads. The
stats and exports are computed by the page with the library's fold (``foldBatches``), so
the page, the CLI and agents read one implementation.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from .content import content_link, load_secret, origin_of
from .store import Store, valid_id
from .web import default_data_dir

MAX_LINK_BODY_BYTES = 8 * 1024
MAX_URL_CHARS = 2048
MAX_READER_CHARS = 200

_HERE = Path(__file__).resolve().parent
#: Where the built owner page is looked for: the deployed ref first, then a local build.
OWNER_PAGE_CANDIDATES = (_HERE.parent / "frontend" / "dist" / "owner.html", _HERE.parent / "dist" / "owner.html")


def _err(status: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status)


def enlace_identity(req: Request) -> str | None:
    """The signed-in user's address as enlace's auth layer puts it on the request (``request.state.user_email``)."""
    return getattr(req.state, "user_email", None)


def mk_owner_app(
    *,
    data_dir: str | os.PathLike | None = None,
    viewer_url: str | None = None,
    owners: list[str] | None = None,
    identity: Callable[[Request], str | None] | None = None,
    page: str | os.PathLike | None = None,
    api_prefix: str = "/api",
) -> Starlette:
    """Make the owner's app.

    :param data_dir: the reader app's data directory (default: ``$ANNOQUEST_SERVER_DATA_DIR``,
        else ``~/.local/share/annoquest/server``).
    :param viewer_url: where readers open the viewer, for links (default: ``$ANNOQUEST_VIEWER_URL``).
    :param owners: who may use it; with ``identity``, anyone else is refused (default: trust the gate in front).
    :param identity: how to read the caller's identity from a request (e.g. :func:`enlace_identity`).
    :param page: the built owner page, served at ``/`` (default: ``frontend/dist/owner.html``, then ``dist/owner.html``).
    :param api_prefix: where the API lives (``""`` under a platform that mounts it at an API path).
    """
    store = Store(Path(data_dir) if data_dir else default_data_dir())
    viewer = viewer_url if viewer_url is not None else os.environ.get("ANNOQUEST_VIEWER_URL", "")
    owner_set = {o.strip().lower() for o in owners or [] if o.strip()}
    api = api_prefix.rstrip("/")
    page_path = Path(page) if page else next((p for p in OWNER_PAGE_CANDIDATES if p.is_file()), None)

    def refused(req: Request) -> Response | None:
        if not owner_set:
            return None
        who = (identity(req) if identity else None) or ""
        return None if who.strip().lower() in owner_set else _err(403, "This page is its owner's.")

    def guarded(endpoint):
        async def run(req: Request):
            return refused(req) or await endpoint(req)

        return run

    async def config(req: Request):
        return JSONResponse({"viewer": viewer or None})

    async def requests(req: Request):
        rows = [s for s in map(store.summary, store.request_ids()) if s]
        rows.sort(key=lambda s: s["lastAt"] or s["registeredAt"] or "", reverse=True)
        return JSONResponse({"requests": rows})

    async def request(req: Request):
        rid = req.path_params["rid"]
        rec = store.get_request(rid) if valid_id(rid) else None
        return JSONResponse({**rec["request"], "revision": rec["revision"]}) if rec else _err(404, "No such request.")

    async def events(req: Request):
        rid = req.path_params["rid"]
        if not valid_id(rid) or not store.get_request(rid):
            return _err(404, "No such request.")
        return JSONResponse({"request": rid, "batches": store.events(rid)})

    async def links(req: Request):
        raw = await req.body()
        if len(raw) > MAX_LINK_BODY_BYTES:
            return _err(413, "Body too large.")
        try:
            data = json.loads(raw)
        except ValueError:
            return _err(400, "Body is not JSON.")
        url = (data.get("url") or "").strip() if isinstance(data, dict) else ""
        reader = ((data.get("reader") or "").strip() or None) if isinstance(data, dict) else None
        if len(url) > MAX_URL_CHARS or origin_of(url) is None:
            return _err(400, "Give the page's full address (http:// or https://).")
        if reader and len(reader) > MAX_READER_CHARS:
            return _err(400, "That reader id is too long.")
        if not viewer:
            return _err(503, "This server does not know where the viewer is (set viewer_url or $ANNOQUEST_VIEWER_URL).")
        return JSONResponse({"link": content_link(load_secret(store.root), url, viewer=viewer, reader=reader), "content": url, "reader": reader})

    async def home(req: Request):
        if page_path and page_path.is_file():
            return FileResponse(page_path, media_type="text/html", headers={"Cache-Control": "no-cache"})
        return HTMLResponse("<h1>annoquest owner</h1><p>The owner page is not built. Run <code>pnpm build</code>.</p>", status_code=503)

    async def api_404(req: Request):
        return _err(404, f"{req.url.path} is not in the API.")

    routes = [
        Route("/", guarded(home)),
        Route(f"{api}/config", guarded(config)),
        Route(f"{api}/requests", guarded(requests)),
        Route(f"{api}/requests/{{rid}}", guarded(request)),
        Route(f"{api}/requests/{{rid}}/events", guarded(events)),
        Route(f"{api}/links", guarded(links), methods=["POST"]),
        Route(f"{api}/{{rest:path}}", guarded(api_404), methods=["GET", "POST", "PUT", "DELETE"]),
    ]
    return Starlette(routes=routes)
