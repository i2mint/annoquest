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

Only configure an identity header that your gateway **overwrites** on every request; otherwise a client can send its own. `mk_x_iq_user_app` is a preset for gateways that use `X-Iq-User`.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/whoami` | anyone | `{"user": …}` |
| PUT | `/api/requests/<id>` | signed in | register a request once (the viewer does this when opened from a `#r=` link) |
| GET | `/api/requests/<id>` | listed readers, owners | the request |
| POST | `/api/requests/<id>/responses` | listed readers, owners | append a save; the server sets `by` |
| GET | `/api/requests/<id>/responses/mine` | the caller | their latest save |
| GET | `/api/requests/<id>/responses` | owners | everyone's latest |
| GET | `/doc/<path>` | anyone who reaches the app | a file from `docs_dir` |

Storage is write-once files, so a per-file backup keeps the whole history. To collect: copy the data directory and run `annoquest collect <dir>/responses/<id> --request request.json`.
