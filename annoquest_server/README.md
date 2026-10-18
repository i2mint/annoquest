# annoquest-server

The server adapter for [annoquest](../README.md): autosubmit and collection behind a forward-auth gateway.

```bash
pip install -e ".[server]"
ANNOQUEST_IDENTITY_HEADER=Remote-User ANNOQUEST_DOCS_DIR=./docs uvicorn annoquest_server:mk_app --factory --port 8130
```

| Setting | Env | Default |
|---|---|---|
| `identity_header` | `ANNOQUEST_IDENTITY_HEADER` | none: anonymous, for local use |
| `data_dir` | `ANNOQUEST_SERVER_DATA_DIR` | `~/.local/share/annoquest/server` |
| `owners` | `ANNOQUEST_OWNERS` (comma-separated) | none (each request's `requester.email` is its owner) |
| `viewer` | `ANNOQUEST_VIEWER` | `frontend/dist/index.html`, then `dist/viewer.html` |
| `docs_dir` | `ANNOQUEST_DOCS_DIR` | none |
| `public` | `ANNOQUEST_PUBLIC` | off: a site with no sign-in in front (readers self-declared, no owner over HTTP) |
| `api_prefix` | | `/api` (`""` when the platform mounts the app under an API path itself) |

`mk_public_app` is `mk_app(public=True, api_prefix="")`, for a platform that mounts the app at `/api/<name>` with no sign-in (enlace).

Only configure an identity header that your gateway **overwrites** on every request; otherwise a client can send its own. `mk_x_iq_user_app` is a preset for gateways that use `X-Iq-User`.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/whoami` | anyone | `{"user": …}` |
| PUT | `/api/requests/<id>` | the sender (first time); anyone holding a stored revision | register a request once (the viewer does this when opened from a `#r=` link); a body matching no revision is a 409 |
| GET | `/api/requests/<id>` | listed readers, owners | the latest revision of the request (with `revision`) |
| POST | `/api/requests/<id>/revisions` | the sender, owners | publish a new revision (same id and sender; each stored once, never overwritten) |
| GET | `/api/requests/<id>/revisions[/<n>]` | the sender, owners | the history, or one revision |
| POST | `/api/requests/<id>/events` | listed readers, owners (public: anyone with the id) | append an event batch; the server sets `by` |
| GET | `/api/requests/<id>/events/mine[?device=]` | the caller (public: the device named, whose id is random) | their batches |
| GET | `/api/requests/<id>/events` | owners (public: nobody) | every batch |
| GET | `/api/proxy?u=<url>&t=<token>` | anyone holding a link for that site | the page, script-less, links rewritten back through the proxy |
| POST | `/api/requests/<id>/responses` | listed readers, owners (not public) | append a whole-document save (before v0.2; still read) |
| GET | `/api/requests/<id>/responses/mine` | the caller | their latest save |
| GET | `/api/requests/<id>/responses` | owners | everyone's latest |
| GET | `/doc/<path>` | anyone who reaches the app | a file from `docs_dir` |

In public mode, a request is registered by the owner on the server (`python -m annoquest_server put-request request.json`; a changed file becomes a new revision), or, for a content link, by the viewer (its token is the permission).

## Owner commands

```bash
python -m annoquest_server link <url> --viewer <viewer url> [--reader id]   # a freeform link for any page
python -m annoquest_server put-request <request.json>                      # register (or revise) a request
python -m annoquest_server events <request id>                             # every event batch, for `annoquest export`
```

They use the same data directory as the app (`ANNOQUEST_SERVER_DATA_DIR`, or `--data-dir`). The signing secret for links is made on first use, in `<data dir>/secret`.

Storage is write-once files, so a per-file backup keeps the whole history. To collect: copy the data directory and run `annoquest collect <dir>/responses/<id> <dir>/events/<id> --request request.json`, or `annoquest export <dir>/events/<id>` for comments and reading time.
