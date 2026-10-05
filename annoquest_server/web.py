"""The HTTP app: the viewer at ``/``, the request and response API under ``/api``.

Identity is whatever the forward-auth gateway in front asserts in ``identity_header``.
That is only safe when the gateway *overwrites* that header on every request (so a
client cannot send its own), which is why the header is configured, never guessed.
With no header configured the app runs anonymously, for local use.

Who may do what:

- only a request's sender (its ``requester.email``, or an owner) may register it (``PUT``) and
  publish revisions of it (``POST .../revisions``); revisions keep the id, are each written once,
  and the latest is what is served; a ``PUT`` of any stored revision is accepted;
- a request's readers (by email, when it lists any) and its owners may open it and answer;
- a reader reads back only their own answers; owners (the request's ``requester.email``,
  plus ``owners``) read everyone's.
"""

from __future__ import annotations

import json
import logging
import os
from functools import partial
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from .store import Store, valid_id, well_formed

_log = logging.getLogger(__name__)

IDENTITY_MAX_CHARS = 254
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSES_BYTES = 2 * 1024 * 1024
#: For documents served at /doc/: no script, still same-origin (so the viewer can read the frame).
DOC_CSP = "sandbox allow-same-origin allow-popups; default-src 'self' data:; style-src 'self' 'unsafe-inline' https:; img-src * data:; font-src * data:"

_HERE = Path(__file__).resolve().parent
#: Where the built viewer is looked for: the deployed ref first, then a local build.
VIEWER_CANDIDATES = (_HERE.parent / "frontend" / "dist" / "index.html", _HERE.parent / "dist" / "viewer.html")


def default_data_dir() -> Path:
    env = os.environ.get("ANNOQUEST_SERVER_DATA_DIR")
    return Path(env) if env else Path.home() / ".local" / "share" / "annoquest" / "server"


def _viewer_path(explicit: str | os.PathLike | None) -> Path | None:
    if explicit:
        return Path(explicit)
    env = os.environ.get("ANNOQUEST_VIEWER")
    if env:
        return Path(env)
    return next((p for p in VIEWER_CANDIDATES if p.is_file()), None)


def _err(status: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status)


def mk_app(
    *,
    identity_header: str | None = None,
    data_dir: str | os.PathLike | None = None,
    owners: list[str] | None = None,
    viewer: str | os.PathLike | None = None,
    dev_user: str | None = None,
    docs_dir: str | os.PathLike | None = None,
) -> Starlette:
    """Make the app.

    :param identity_header: the header the gateway overwrites with the signed-in user
        (default: ``$ANNOQUEST_IDENTITY_HEADER``; none means anonymous).
    :param data_dir: where requests and responses live (default: ``$ANNOQUEST_SERVER_DATA_DIR``,
        else ``~/.local/share/annoquest/server``).
    :param owners: identities that may read every request's answers (default: ``$ANNOQUEST_OWNERS``, comma-separated).
    :param viewer: the built viewer HTML (default: ``frontend/dist/index.html`` beside the package, then ``dist/viewer.html``).
    :param dev_user: a fixed identity for local testing; never set behind a gateway.
    :param docs_dir: a folder served read-only at ``/doc/``, so its documents are same-origin
        with the viewer (default: ``$ANNOQUEST_DOCS_DIR``; none serves nothing there).
    """
    header = identity_header or os.environ.get("ANNOQUEST_IDENTITY_HEADER") or None
    owner_set = {o.strip().lower() for o in (owners if owners is not None else os.environ.get("ANNOQUEST_OWNERS", "").split(",")) if o.strip()}
    store = Store(Path(data_dir) if data_dir else default_data_dir())
    viewer_path = _viewer_path(viewer)
    if viewer_path is None or not viewer_path.is_file():
        _log.warning("no built viewer found (looked at %s); `/` will say so", [str(p) for p in VIEWER_CANDIDATES])

    def identity(req: Request) -> str | None:
        if dev_user:
            return dev_user.lower()
        if not header:
            return None
        cleaned = " ".join((req.headers.get(header) or "").split())[:IDENTITY_MAX_CHARS].strip().lower()
        return cleaned or None

    def is_owner(user: str | None, request: dict) -> bool:
        if user is None:
            return not header and not dev_user  # anonymous local mode: one person, all access
        return user in owner_set or user == ((request.get("requester") or {}).get("email") or "").lower()

    def may_read(user: str | None, request: dict) -> bool:
        emails = [r["email"].lower() for r in request.get("readers") or [] if r.get("email")]
        return is_owner(user, request) or not emails or user in emails

    async def body_json(req: Request, limit: int):
        declared = req.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            return None, _err(413, f"Body over {limit} bytes.")
        raw = b""
        async for chunk in req.stream():
            raw += chunk
            if len(raw) > limit:
                return None, _err(413, f"Body over {limit} bytes.")
        try:
            return json.loads(raw), None
        except ValueError:
            return None, _err(400, "Body is not JSON.")

    def load(rid: str):
        if not valid_id(rid):
            return None, _err(400, "Not a request id.")
        rec = store.get_request(rid)
        return ({**rec["request"], "revision": rec["revision"]}, None) if rec else (None, _err(404, "No such request. Open the link you were sent once, so it is registered."))

    async def whoami(req: Request):
        return JSONResponse({"user": identity(req)})

    async def request_endpoint(req: Request):
        rid = req.path_params["rid"]
        user = identity(req)
        if req.method == "PUT":
            if not valid_id(rid):
                return _err(400, "Not a request id.")
            data, err = await body_json(req, MAX_REQUEST_BYTES)
            if err:
                return err
            if not isinstance(data, dict) or data.get("id") != rid or data.get("schema") != "annoquest/request":
                return _err(400, "The body is not the annoquest request with this id.")
            if (header or dev_user) and not user:
                return _err(401, "Sign in to register a request.")
            revs = store.revisions(rid)
            if revs:
                # Anyone holding a link to an older or the current revision is fine; a body matching
                # none is a different request under this id: say so, so it cannot pass quietly.
                # `revision` is the server's annotation, not content: compare without it on both sides.
                strip = lambda r: json.dumps({k: v for k, v in (r or {}).items() if k != "revision"}, sort_keys=True)  # noqa: E731
                canon = strip(data)
                hit = next((r for r in revs if strip(r.get("request")) == canon), None)
                if hit:
                    out = {"id": rid, "created": False}
                    if may_read(user, revs[-1]["request"]):
                        out |= {"revision": hit["revision"], "latest": revs[-1]["revision"]}
                    return JSONResponse(out)
                return _err(409, "A different request is already registered under this id.")
            # Only its sender registers a request: a reader who could register it first would own it.
            if not is_owner(user, data):
                return _err(403, "Only the sender of this request (its requester) can register it.")
            created = store.put_request(data, by=user)
            if not created:  # lost a race with an identical or different registration
                stored = (store.get_request(rid) or {}).get("request")
                if json.dumps(stored, sort_keys=True) != json.dumps(data, sort_keys=True):
                    return _err(409, "A different request is already registered under this id.")
            return JSONResponse({"id": rid, "created": created}, status_code=201 if created else 200)
        request, err = load(rid)
        if err:
            return err
        if not may_read(user, request):
            return _err(403, "This request was not sent to you.")
        return JSONResponse(request)

    async def revisions_endpoint(req: Request):
        rid = req.path_params["rid"]
        user = identity(req)
        if not valid_id(rid):
            return _err(400, "Not a request id.")
        revs = store.revisions(rid)
        if not revs:
            return _err(404, "No such request.")
        first = revs[0]["request"]
        # Ownership comes from the first registration: a revision cannot change who owns it.
        if not is_owner(user, first):
            return _err(403, "Only the sender of this request can revise it or read its history.")
        if req.method == "GET":
            return JSONResponse({"request": rid, "revisions": [{"revision": r["revision"], "at": r.get("at"), "by": r.get("by"), "items": len(r["request"].get("items") or []), "title": r["request"].get("title")} for r in revs]})
        if (header or dev_user) and not user:
            return _err(401, "Sign in to revise a request.")
        data, err = await body_json(req, MAX_REQUEST_BYTES)
        if err:
            return err
        if not isinstance(data, dict) or data.get("id") != rid or data.get("schema") != "annoquest/request":
            return _err(400, "The body is not a revision of this request (same id, an annoquest request).")
        if ((data.get("requester") or {}).get("email") or "").lower() != ((first.get("requester") or {}).get("email") or "").lower():
            return _err(400, "A revision keeps the request's sender.")
        data = {k: v for k, v in data.items() if k != "revision"}
        latest = revs[-1]["request"]
        if json.dumps({k: v for k, v in latest.items() if k != "revision"}, sort_keys=True) == json.dumps(data, sort_keys=True):
            return JSONResponse({"id": rid, "revision": revs[-1]["revision"], "created": False})
        n = store.add_revision(data, by=user)
        return JSONResponse({"id": rid, "revision": n, "created": True}, status_code=201)

    async def revision_n(req: Request):
        rid, n = req.path_params["rid"], req.path_params["n"]
        user = identity(req)
        revs = store.revisions(rid) if valid_id(rid) else []
        if not revs:
            return _err(404, "No such request.")
        if not is_owner(user, revs[0]["request"]):
            return _err(403, "Only the sender of this request can read its history.")
        hit = next((r for r in revs if str(r["revision"]) == n), None)
        return JSONResponse({**hit["request"], "revision": hit["revision"]}) if hit else _err(404, "No such revision.")

    async def responses_endpoint(req: Request):
        rid = req.path_params["rid"]
        user = identity(req)
        request, err = load(rid)
        if err:
            return err
        if not may_read(user, request):
            return _err(403, "This request was not sent to you.")
        if req.method == "POST":
            if (header or dev_user) and not user:
                return _err(401, "Sign in to send answers.")
            data, err = await body_json(req, MAX_RESPONSES_BYTES)
            if err:
                return err
            if not isinstance(data, dict) or data.get("request") != rid or data.get("schema") != "annoquest/responses" or not well_formed(data):
                return _err(400, "The body is not annoquest responses for this request.")
            name = store.add_responses(rid, data, by=user or "anonymous")
            return JSONResponse({"saved": name}, status_code=201)
        if not is_owner(user, request):
            return _err(403, "Only the requester can read everyone's answers.")
        return JSONResponse({"request": rid, "responses": list(store.latest_all(rid))})

    async def mine(req: Request):
        rid = req.path_params["rid"]
        user = identity(req) or "anonymous"
        _, err = load(rid)
        if err:
            return err
        rec = store.latest(rid, user)
        return JSONResponse(rec) if rec else _err(404, "No answers yet.")

    async def api_404(req: Request):
        return _err(404, f"{req.url.path} is not in the API.")

    async def page(req: Request):
        if viewer_path and viewer_path.is_file():
            return FileResponse(viewer_path, media_type="text/html", headers={"Cache-Control": "no-cache"})
        return HTMLResponse("<h1>annoquest</h1><p>The viewer is not built. Run <code>pnpm build</code>.</p>", status_code=503)

    docs_root = docs_dir or os.environ.get("ANNOQUEST_DOCS_DIR")

    async def doc(req: Request):
        if not docs_root:
            return _err(404, "No documents are served here.")
        root = Path(docs_root).resolve()
        target = (root / req.path_params["path"]).resolve()
        if root not in target.parents or not target.is_file() or any(part.startswith(".") for part in target.relative_to(root).parts):
            return _err(404, "No such document.")
        # Served same-origin with the viewer, so a document must never run script here,
        # whether framed, opened in a new tab, or visited directly.
        return FileResponse(target, headers={"Content-Security-Policy": DOC_CSP, "X-Content-Type-Options": "nosniff"})

    routes = [
        Route("/doc/{path:path}", doc),
        Route("/api/whoami", whoami),
        Route("/api/requests/{rid}", request_endpoint, methods=["GET", "PUT"]),
        Route("/api/requests/{rid}/responses", responses_endpoint, methods=["GET", "POST"]),
        Route("/api/requests/{rid}/revisions", revisions_endpoint, methods=["GET", "POST"]),
        Route("/api/requests/{rid}/revisions/{n}", revision_n),
        Route("/api/requests/{rid}/responses/mine", mine),
        Route("/api/{rest:path}", api_404, methods=["GET", "POST", "PUT", "DELETE"]),
        Route("/", page),
    ]
    return Starlette(routes=routes)


#: Preset for gateways that assert the signed-in user's email in ``X-Iq-User``.
mk_x_iq_user_app = partial(mk_app, identity_header="X-Iq-User")


def serve(*, host: str = "127.0.0.1", port: int = 8130, **kwargs) -> None:  # pragma: no cover
    """Run locally (anonymous unless an identity header or dev user is given)."""
    import uvicorn

    uvicorn.run(mk_app(**kwargs), host=host, port=port)
