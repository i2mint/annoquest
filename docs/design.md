# annoquest — design

*2026-10-02 · v0.1; 2026-10-19 · v0.2 (freeform, event log, content links: see [below](#v02-freeform-annotation-the-event-log-and-content-links)) · research: [prior-art.md](research/prior-art.md), [browser-techniques.md](research/browser-techniques.md)*

## What it is

A **guided annotation request**: someone (usually an agent acting for a requester) gives a reader a set of documents plus a prioritised list of **items**. Each item points at a section or a passage, asks something, and says how to answer: a "read" tick, agree / discuss / disagree, implemented / will implement, a free comment, a label. The reader opens one link, is walked through the most important items first, answers, and can annotate anything else they notice. Every answer is saved on the device as it is given and, when a sink is configured, submitted automatically. The requester (or their agent) collects the answers and sees where people are aligned, where they are not, and what is still unanswered.

Alignment between two people is one use. Sign-off, read-and-acknowledge, structured feedback on a draft, and labelling a document are others. The vocabulary is therefore the general one: *request*, *item*, *response type*, *answer*, *tone*. Nothing in the core says "alignment".

The research found nothing that joins the three families this needs: web annotation overlays (anchoring, highlights), review and sign-off tools (dispositions, per-section states), and human-in-the-loop primitives for agents (an agent asks a person for structured input and gets it back). annoquest is that join. It takes the anchoring model from W3C Web Annotation and Hypothesis, the response states from Reviewable, Gerrit, the IETF ballot and Kaner's gradients of agreement, and the agent shape from MCP elicitation.

## The data model (the SSOT is `src/spec.ts`, in Zod)

- **Request**: `id` (random, unguessable), `title`, `intro`, `requester`, optional `readers`, `mode` (`guided` one card at a time, or `checklist` the full list), `documents`, `items`, `responseTypes` (custom presets), `sink`, `allowExtra`.
- **Document**: `id`, `title`, and a `source`: `{kind: 'url', url}` (live) or `{kind: 'inline', html}` (a snapshot baked in).
- **Item**: `id`, `doc`, `target` (`section`: an element id; `quote`: W3C `TextQuoteSelector` `{exact, prefix, suffix}`; both optional), `title`, `prompt`, `priority` (`must` / `should` / `could`), `response` (a preset name or an inline response type), `labels` (per-item option wording), `comment` (`none` / `optional` / `required`), `minutes`, `readers` (a subset), `passageHash`.
- **Response type**: `kind` (`ack`, `choice`, `multi`, `text`) and `options`, each `{value, label, tone}` with tone one of `positive`, `neutral`, `attention`, `blocking`. A blocking option always requires a comment. Built-in presets: `read`, `noted`, `agree`, `consent`, `implement`, `approve`, `gradient`, `fist-to-five`, `moscow`, `comment`, `label`.
- **Responses** (one document per request and reader): `answers` keyed by item id (`value`, `comment`, `at`, `rev`, `passageHash`), `extras` (the reader's own annotations, with a quote target), `finishedAt`.

Tones are what make collection preset-agnostic: an item is **aligned** when every answer is positive, **blocked** when any is blocking, **to discuss** when any needs attention, and **pending** while someone has not answered. A stored `passageHash` lets the summary flag an answer as **stale** when the passage it answered has since changed (GitHub's "Viewed" box does the same).

## Seams

Each seam is one argument or one tagged field of the spec. The default is the strongest implementation that needs no server; the replacement in the right-hand column is built, not imagined.

| # | Seam | v1 default (no server) | Other implementation in v1 |
|---|---|---|---|
| 1 | **Document source**: how the document reaches the viewer | `inline`: the CLI reads the HTML (file or URL; no CORS in Node) and bakes it into the request page. It is shown in a script-less same-origin frame, or, when the viewer itself runs in an opaque origin (a host that sandboxes it without `allow-same-origin`, a file opened from mail), parsed inertly, sanitised and rendered into a shadow root of the viewer, so highlighting and navigation still work | `url`: a live same-origin page loaded in the frame; cross-origin pages degrade to the passage-in-card view with a `#:~:text=` link to the original. `scripts: true` lets a trusted page run its own scripts (dashboards, SPAs), re-anchoring after each re-render; never for inline snapshots, whose scripts would run in the viewer's origin |
| 2 | **Delivery**: how the reader gets the request | `bake`: one self-contained HTML file (viewer + request + snapshot), hostable anywhere, or attachable | `#r=<z1 payload>` in a link (holdall's codec; fine to ~2 KB for email, longer for chat), and `?spec=<url>` pointing at hosted JSON |
| 3 | **Client storage**: where answers live on the device | `@zodal/store-localstorage` `DataProvider`, one record per request and reader, merged with what is stored and written on every change | any zodal `DataProvider` (IndexedDB, HTTP) passed to `mountViewer(root, {store})` (`viewer/main.tsx`) |
| 4 | **Sink**: how answers come back | `local`: kept on the device; the done screen gives a reply link and a JSON download | `http`: every change is an **event** (v0.2), queued on the device and posted in small batches (debounced, `keepalive` on `pagehide` / hidden, retried with backoff, kept in an outbox across reloads) to an endpoint that keeps one write-once file per batch; the state is a pure fold of the events. A new sink kind is a new `sink.kind` in the spec plus one case in `makeSink` (`viewer/persist.ts`) |
| 5 | **Identity**: who answered | self-declared: `?reader=<id>` (alias `?user_id=`) from the link, else a random device id kept in this browser, plus the name the reader types | server-asserted: the `http` sink's server stamps the gateway's user header on every write and answers `/whoami` for display |

The server adapter is a small Python ASGI app (`annoquest_server`, in this repo) that serves the viewer at `/`, stores requests write-once and responses append-only, reads identity from a configurable forward-auth header, and lets a request's requester read every reader's answers while a reader reads only their own. It is one deployment of seam 4 + 5, not part of the core.

**Revisions.** A request id names one request with revisions: its sender publishes new versions under the same id (each stored once, never overwritten), the server serves the latest, and the link already sent keeps working. Answers bind by item id; each answer records a hash of the item it answered (`itemHash`), so an answered item a revision changed reads *updated since you last answered*, and answers to items a revision removed stay in the reader's responses and in the summary's *removed* list.

**Registration rule.** Only a request's sender (its `requester.email`, or a configured owner) can register it on a server, and a request is registered once. The sender therefore opens the link before sending it: the viewer registers it and shows a *preview* banner, and nothing the sender clicks is sent. If someone else registers the id first, they can only do it by naming themselves as sender, and the real sender's preview then gets a conflict (HTTP 409) and an error saying the link does not match. Nothing is taken over quietly, but the sender must make a fresh request. The residual risk is a reader who gets the link before the sender has opened it: that is the step the sender must not skip. A reader who opens a request that is not yet registered keeps their answers on the device; they are sent once it exists.

**NOT seams** (written directly, on purpose): the anchoring algorithm (exact match, then context-scored fuzzy match), the highlight mechanism (CSS Custom Highlight API with a `<mark>` fallback), the guide panel's layout, the summary's markdown format, the CLI's argument parsing.

## Surfaces

- **Agent primitives** (`src/index.ts`): `createRequest`, `checkRequest` (anchors resolve uniquely against the document text), `bakeRequest`, `requestLink`, `parseResponses`, `summarize`, `summaryMarkdown`, `presets`, `toElicitation` (an item as an MCP elicitation schema). Plain functions, JSON in, JSON out.
- **CLI** (`annoquest`): `schema`, `presets`, `check`, `bake`, `link`, `collect`. JSON on stdout, errors with a non-zero exit, nothing interactive.
- **Viewer**: a single-file web app (React, zustand) built into `dist/viewer.html`; `bake` injects a request into it, and the server serves it as is.
- **Shipped agent skill**: `skills/annoquest/SKILL.md`, the procedure for an agent building a request.
- Asked and not built: MCP server (the primitives are already JSON-in/JSON-out and `toElicitation` exists; adding it needs no core change), encrypted `ntfy` sink (zero-config autosubmit through a third party; see Open questions), browser extension, an owner web page for exports and link-making (v0.2 does both from the command line).

## Guidance UX (from the research)

- One primary action, **Next**, walking items by priority, then document order. Within a tier, quick items (`read`, `noted`) come first: progress that starts fast reduces drop-off.
- Tiers are the two-level disclosure: the current tier expanded, later tiers collapsed with their counts; nothing is hidden without a count. Per-tier progress, and a pause point at the end of each tier ("the must-dos are done — keep going?").
- The card shows the passage itself, not only a pointer to it (a "read" tick is weak evidence of reading).
- Blocking answers ask for a reason; every preset has a neutral escape ("not my area").
- The save state is always visible and honest: *saved on this device*, *sent*, *will send when online*, *sign in again*.

## Open questions

- **Zero-config autosubmit.** The only autosubmit that needs neither setup nor a server of one's own is a public relay such as ntfy.sh, with the payload encrypted in the browser under a key carried in the link fragment. It keeps messages only hours and its operator sees metadata. v1 ships `local` (reply link + download) as the default and `http` for real autosubmit; an encrypted-relay sink is the next sink if wanted.
- **Multiple rounds** (Delphi-style: show the aggregate, let people revise) fit the model as a `round` field; not built.

## v0.2: freeform annotation, the event log, and content links

*2026-10-19.* The ask: send someone one link that shows a page from another address, lets them highlight passages and comment on them, follows the links they click, records which pages they open and for how long, sends everything as it happens (no submit button), lets them come back and edit, and lets the requester rebuild the final state from what was sent. Guided requests keep working, and one request can be guided, freeform, or both.

### One model: a request with items, freeform, or both

- `items` may be empty. A request with no items and `allowExtra` (already "let the reader annotate passages no item points at", so it keeps its name) is a **freeform** request: the panel shows the instructions, the reader's comments (editable, grouped by page), and nothing to walk through. With items, the guide is as before and the comments list sits under it.
- `track: true` asks the viewer to record navigation and reading time (below). Off by default; content links turn it on, and their instructions say so.
- An **extra** (the reader's own annotation) gains `url`, the page it was made on (a reader can follow links away from the document), and `rev`, so an edited comment wins over its earlier text in any merge or fold, exactly as answers already do.
- **Anchors** stay the W3C `TextQuoteSelector` (`exact`, `prefix`, `suffix`), which survives edits to the page, plus a new `occurrence`: which match of `exact` in the page this is, from 1. The viewer always records it, so an export reads as the asked-for *(page, text, occurrence, comment)*; anchoring uses it only to break a tie the context cannot.

### Identity: `reader`, with `user_id` as an alias

The link's `?reader=` was already the self-declared id; `?user_id=` is accepted as the same thing, so a link written either way works. Without either, the viewer makes a random id on first visit and keeps it in this browser's storage (`annoquest:device`); it is the reader's id until a link names one, and is sent with every event as `device`. No fingerprinting: an IP plus browser signature is personal data whose use needs consent under GDPR / ePrivacy, is unstable (mobile networks, updates), and adds nothing a stored random id does not. The instructions shown on opening say plainly that everything, including which pages are opened and for how long, is sent automatically; that is the notice. A reader who clears site data (or Safari's 7-day rule for script-written storage) starts with a new id: nothing on the server is lost, it is simply a second reader key in the export.

### The event log is the truth

Every change the reader makes, and every page they look at, is an **event**: small, append-only, with a random `id` (so a resend is harmless), the `session` (one per page load), a per-session `seq`, the client time `at`, the `reader` and `device`. Types:

| type | payload | when |
|---|---|---|
| `open` | viewport size | a session starts |
| `view` | `url`, `title` | a page is shown in the frame: the first load, a followed link, an in-app route (`#/…`) |
| `visibility` | `state` | the tab is hidden or shown again |
| `beat` | `url`, `active`, `depth` | every 15 s while visible; `active` if the reader scrolled, pointed or typed since the last one; `depth` the furthest fraction of the page scrolled to |
| `answer` | `item`, the whole `answer` (with its `rev`) | an item is answered or the answer changes |
| `extra` | the whole extra (with its `rev`) | a comment is added or edited |
| `remove` | `extra` id | a comment is deleted (a tombstone) |
| `name`, `finish` | the name; nothing | as before |

Events carry *states*, not diffs: an `answer` or `extra` event holds the full record at that revision, so the **fold** (`foldEvents`, pure, in `src/events.ts`) is: dedupe by id, order by `(at, seq)`, keep per answer and per extra the highest `(rev, at)`, apply tombstones. It gives back the same `Responses` document the viewer holds, so `collect`, `summarize` and the reply link work unchanged on it. The viewer does not decide what to send in the UI code: it diffs the previous and next `Responses` on every store change and emits what changed, so the state code stays as it was. On reload the viewer folds what it kept and what the server holds for this device, and resends anything the server lacks (closed offline) the same way.

**Analytics** come from the same fold: per reader and per page, the views, first and last time seen, *dwell* (time the page was on screen with the tab visible, each gap capped at 45 s so a laptop left open does not read as an hour of reading), *active* time (the part with interaction), and the furthest scroll depth; plus sessions and a timeline. That is the export: `annoquest export <events…> [--request] --format json|markdown`, final state plus analytics per reader.

### Content links, and why a proxy

`thorwhalen.com/annoquest/?content=<url>&t=<token>[&reader=<id>]` opens any page for freeform annotation; the viewer builds the request itself (one document, no items, `allowExtra`, `track`, the default instructions, the server's sink), with an id derived from the token and the URL so every reader of one link lands in one request.

Highlighting needs the page's DOM, which a frame from another origin hides. So:

- **A page on the viewer's own origin** (e.g. `thorwhalen.com/cosmo_compass/`) is framed directly, with its scripts on: it already runs on this origin when visited, so framing it adds no trust, and single-page apps (Cosmo Compass is one) only render with scripts. Its in-app routes count as pages.
- **A page anywhere else** goes through the server's **proxy**: it fetches the HTML, makes every subresource absolute to the original host (images and styles load from there), rewrites same-site links back through the proxy (so following them stays annotatable) and other links to open a new tab, drops scripts, `<base>` and meta refreshes, and serves it with `Content-Security-Policy: sandbox allow-same-origin allow-popups …` and no `script-src`: no script runs in it, framed or visited directly. Pages drawn by JavaScript therefore show only their server-rendered part; that is the price of not running a stranger's code on this origin.
- **Not an open proxy.** The token is an HMAC, under a secret the server makes for itself in its data directory, of the page's *origin*: it lets that one site be proxied (and its links followed) and lets a content request for it be registered, nothing else. Links are made by the server's owner (`python -m annoquest_server link <url>`, which prints the link). The proxy also refuses non-http(s), non-default ports, and any host that resolves to a private, loopback, link-local or reserved address (checked on the resolved address it then connects to, and on every redirect hop, so DNS rebinding cannot slip through), caps the page at 5 MB and 10 s, and only proxies HTML (anything else gets a page with a link to open it in a new tab).
- Same origin, honestly stated: a proxied page is served from the viewer's origin, without scripts or forms, so it cannot read storage or post anything; its images can still request URLs on this origin, which is why only sites the owner chose are proxied.

### Server: a public mode beside the gateway mode

`mk_app(public=True)` is the deployment for a site with no sign-in in front (tw): readers are who their events say; requests are readable by anyone holding their (unguessable) id; a request is registered by its owner on the server (`python -m annoquest_server put-request <file>`, the same write-once store) or, for a content request, by any viewer holding a valid token; events are accepted for registered requests, size-capped per batch and per reader; a device reads back only its own events (its id is random, so nobody else can ask for them); nobody reads everyone's answers over HTTP; the owner exports from the data directory. `api_prefix` (default `/api`) lets a platform that mounts the app under its own path (enlace mounts it at `/api/annoquest`) drop the inner `/api`. The gateway mode (iq) is unchanged, with events added beside the old whole-document saves, which it still reads.

Storage adds `events/<request id>/<device>/<stamp>.json` (`{"events", "by", "at"}`), write-once like everything else.

### Deployment on tw

A path, `thorwhalen.com/annoquest/`, not a subdomain: on the same origin as every page the owner hosts, those are annotated live with their scripts, with no proxy; enlace mounts apps by path, so it needs no new DNS name, certificate or edge route. The tw_platform app is a page shell (the built viewer with `<meta name="annoquest-api" content="/api/annoquest">`) and a three-line `server.py` over `annoquest_server.mk_app(public=True, api_prefix="")`, `access = "public"`, unlisted.

### Not built in v0.2

An owner web page (list requests, read exports, make links from a phone): needs a second, signed-in enlace app over the same data directory, and the CLI covers it for agents. Reading answers back across devices for a self-declared reader: it would let anyone who knows a reader's id read their comments.
