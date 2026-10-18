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

With ``public=True`` (a site with no sign-in in front) nobody is an owner over HTTP: readers
are who their events say, a request is readable by whoever holds its unguessable id, it is
registered on the server by its owner (``python -m annoquest_server put-request``) or, for a
content request, by a viewer holding a valid token (see ``content``); events are accepted for
registered requests, a device reads back only its own, and the owner exports from the data
directory. Answers arrive as events (``POST .../events``) in every mode; the whole-document
saves (``.../responses``) are still read, so answers given before the event log keep counting.
"""

from __future__ import annotations

import json
import logging
import os
from functools import partial
from pathlib import Path

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from .content import is_content_request, load_secret, token_allows
from .proxy import PROXY_HEADERS, ProxyRefused, decode, notice_page, proxy_link, rewrite, safe_fetch
from .store import Store, valid_id, well_formed, well_formed_batch

_log = logging.getLogger(__name__)

IDENTITY_MAX_CHARS = 254
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSES_BYTES = 2 * 1024 * 1024
MAX_EVENTS_BYTES = 256 * 1024
#: Posts kept per device and request: about two days of continuous reading; bounds what a stranger can store.
MAX_EVENT_FILES = 20_000
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
    public: bool | None = None,
    api_prefix: str = "/api",
    fetch=safe_fetch,
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
    :param public: no sign-in in front: self-declared readers, no owner over HTTP (default:
        ``$ANNOQUEST_PUBLIC``). Ignored when an identity header is set.
    :param api_prefix: where the API lives in this app (default ``/api``; ``""`` when the
        platform already mounts the app under an API path, as enlace does at ``/api/<app>``).
    :param fetch: how the proxy gets a page (``proxy.safe_fetch``; tests pass a fake).
    """
    header = identity_header or os.environ.get("ANNOQUEST_IDENTITY_HEADER") or None
    owner_set = {o.strip().lower() for o in (owners if owners is not None else os.environ.get("ANNOQUEST_OWNERS", "").split(",")) if o.strip()}
    store = Store(Path(data_dir) if data_dir else default_data_dir())
    public = (os.environ.get("ANNOQUEST_PUBLIC", "").lower() in ("1", "true", "yes")) if public is None else public
    public = bool(public) and not header and not dev_user
    api = api_prefix.rstrip("/")
    _secret: list[bytes] = []

    def secret() -> bytes:
        if not _secret:
            _secret.append(load_secret(store.root))
        return _secret[0]
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
        if public:
            return False  # the owner works from the data directory
        if user is None:
            return not header and not dev_user  # anonymous local mode: one person, all access
        return user in owner_set or user == ((request.get("requester") or {}).get("email") or "").lower()

    def may_read(user: str | None, request: dict) -> bool:
        if public:
            return True  # whoever holds the (unguessable) id
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
            # A content request is the exception: the token in it is the server's own permission.
            if public and not is_content_request(secret(), data):
                return _err(403, "Requests are registered on this server by its owner (python -m annoquest_server put-request).")
            if not public and not is_owner(user, data):
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
            if public:
                return _err(403, "Answers are sent as events here.")
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
        if public:
            return _err(404, "No answers yet.")
        rec = store.latest(rid, user)
        return JSONResponse(rec) if rec else _err(404, "No answers yet.")

    async def events_endpoint(req: Request):
        rid = req.path_params["rid"]
        user = identity(req)
        request, err = load(rid)
        if err:
            return err
        if not may_read(user, request):
            return _err(403, "This request was not sent to you.")
        if req.method == "GET":
            if not is_owner(user, request):
                return _err(403, "Only the requester can read everyone's events.")
            return JSONResponse({"request": rid, "batches": store.events(rid)})
        if (header or dev_user) and not user:
            return _err(401, "Sign in to send answers.")
        data, err = await body_json(req, MAX_EVENTS_BYTES)
        if err:
            return err
        if not well_formed_batch(data) or data.get("request") != rid or data.get("schema", "annoquest/events") != "annoquest/events":
            return _err(400, "The body is not an annoquest event batch for this request.")
        if store.event_files(rid, data["device"]) >= MAX_EVENT_FILES:
            return _err(429, "This device has sent as much as this server keeps for one request.")
        name = store.add_events(rid, {k: v for k, v in data.items() if k not in ("by", "receivedAt")}, by=user)
        return JSONResponse({"saved": name}, status_code=201)

    async def events_mine(req: Request):
        rid = req.path_params["rid"]
        user = identity(req)
        _, err = load(rid)
        if err:
            return err
        device = req.query_params.get("device")
        if header or dev_user:
            if not user:
                return _err(401, "Sign in to read your answers.")
            batches = store.events(rid, by=user)
        elif device:
            batches = store.events(rid, device=device)  # a random id: only its device knows it
        elif not public:
            batches = store.events(rid)  # anonymous local mode: one person
        else:
            return _err(400, "Say which device (?device=).")
        return JSONResponse({"request": rid, "batches": batches})

    async def proxy(req: Request):
        url, token = req.query_params.get("u", ""), req.query_params.get("t", "")
        allowed = lambda u: token_allows(secret(), token, u)  # noqa: E731
        if not allowed(url):
            return HTMLResponse(notice_page("This page is not open for annotation here: the link is incomplete or was not made for this site.", url=url if url.startswith(("http://", "https://")) else None), status_code=403, headers=PROXY_HEADERS)
        try:
            got = await run_in_threadpool(fetch, url, allowed=allowed)
        except ProxyRefused as e:
            return HTMLResponse(notice_page(str(e), url=url), status_code=e.status, headers=PROXY_HEADERS)
        if not got.body and got.content_type not in ("text/html", "application/xhtml+xml"):
            return HTMLResponse(notice_page("This is a file, not a page, so it cannot be annotated here.", url=got.url), headers=PROXY_HEADERS)
        page = rewrite(decode(got.body, got.charset), url=got.url, link=proxy_link(token, allowed=allowed))
        return HTMLResponse(page, status_code=200 if got.status < 400 else got.status, headers=PROXY_HEADERS)

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
        Route("/", page),
        Route("/doc/{path:path}", doc),
        Route(f"{api}/whoami", whoami),
        Route(f"{api}/proxy", proxy),
        Route(f"{api}/requests/{{rid}}", request_endpoint, methods=["GET", "PUT"]),
        Route(f"{api}/requests/{{rid}}/responses", responses_endpoint, methods=["GET", "POST"]),
        Route(f"{api}/requests/{{rid}}/events", events_endpoint, methods=["GET", "POST"]),
        Route(f"{api}/requests/{{rid}}/events/mine", events_mine),
        Route(f"{api}/requests/{{rid}}/revisions", revisions_endpoint, methods=["GET", "POST"]),
        Route(f"{api}/requests/{{rid}}/revisions/{{n}}", revision_n),
        Route(f"{api}/requests/{{rid}}/responses/mine", mine),
        Route(f"{api}/{{rest:path}}", api_404, methods=["GET", "POST", "PUT", "DELETE"]),
    ]
    return Starlette(routes=routes)


#: Preset for gateways that assert the signed-in user's email in ``X-Iq-User``.
mk_x_iq_user_app = partial(mk_app, identity_header="X-Iq-User")

#: Preset for a platform that mounts the app at an API path of its own, with no sign-in (enlace's ``public``).
mk_public_app = partial(mk_app, public=True, api_prefix="")


def serve(*, host: str = "127.0.0.1", port: int = 8130, **kwargs) -> None:  # pragma: no cover
    """Run locally (anonymous unless an identity header or dev user is given)."""
    import uvicorn

    uvicorn.run(mk_app(**kwargs), host=host, port=port)
