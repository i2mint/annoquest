# annoquest — design

*2026-10-02 · v0.1 · research: [prior-art.md](research/prior-art.md), [browser-techniques.md](research/browser-techniques.md)*

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
| 1 | **Document source**: how the document reaches the viewer | `inline`: the CLI reads the HTML (file or URL; no CORS in Node) and bakes it into the request page. It is shown in a script-less same-origin frame, or, when the viewer itself runs in an opaque origin (a host that sandboxes it without `allow-same-origin`, a file opened from mail), parsed inertly, sanitised and rendered into a shadow root of the viewer, so highlighting and navigation still work | `url`: a live same-origin page loaded in the frame; cross-origin pages degrade to the passage-in-card view with a `#:~:text=` link to the original |
| 2 | **Delivery**: how the reader gets the request | `bake`: one self-contained HTML file (viewer + request + snapshot), hostable anywhere, or attachable | `#r=<z1 payload>` in a link (holdall's codec; fine to ~2 KB for email, longer for chat), and `?spec=<url>` pointing at hosted JSON |
| 3 | **Client storage**: where answers live on the device | `@zodal/store-localstorage` `DataProvider`, one record per request and reader, merged with what is stored and written on every change | any zodal `DataProvider` (IndexedDB, HTTP) passed to `mountViewer(root, {store})` (`viewer/main.tsx`) |
| 4 | **Sink**: how answers come back | `local`: kept on the device; the done screen gives a reply link and a JSON download | `http`: autosubmit (debounced, sent directly with `keepalive` on `pagehide` / hidden, retried with backoff, resent after a reload if the server is behind) to an endpoint that keeps one append-only file per save. A new sink kind is a new `sink.kind` in the spec plus one case in `makeSink` (`viewer/persist.ts`) |
| 5 | **Identity**: who answered | self-declared: `?reader=<id>` from the link, or the name the reader types | server-asserted: the `http` sink's server stamps the gateway's user header on every write and answers `/whoami` for display |

The server adapter is a small Python ASGI app (`annoquest_server`, in this repo) that serves the viewer at `/`, stores requests write-once and responses append-only, reads identity from a configurable forward-auth header, and lets a request's requester read every reader's answers while a reader reads only their own. It is one deployment of seam 4 + 5, not part of the core.

**Registration rule.** Only a request's sender (its `requester.email`, or a configured owner) can register it on a server, and a request is registered once. The sender therefore opens the link before sending it: the viewer registers it and shows a *preview* banner, and nothing the sender clicks is sent. If someone else registers the id first, they can only do it by naming themselves as sender, and the real sender's preview then gets a conflict (HTTP 409) and an error saying the link does not match. Nothing is taken over quietly, but the sender must make a fresh request. The residual risk is a reader who gets the link before the sender has opened it: that is the step the sender must not skip. A reader who opens a request that is not yet registered keeps their answers on the device; they are sent once it exists.

**NOT seams** (written directly, on purpose): the anchoring algorithm (exact match, then context-scored fuzzy match), the highlight mechanism (CSS Custom Highlight API with a `<mark>` fallback), the guide panel's layout, the summary's markdown format, the CLI's argument parsing.

## Surfaces

- **Agent primitives** (`src/index.ts`): `createRequest`, `checkRequest` (anchors resolve uniquely against the document text), `bakeRequest`, `requestLink`, `parseResponses`, `summarize`, `summaryMarkdown`, `presets`, `toElicitation` (an item as an MCP elicitation schema). Plain functions, JSON in, JSON out.
- **CLI** (`annoquest`): `schema`, `presets`, `check`, `bake`, `link`, `collect`. JSON on stdout, errors with a non-zero exit, nothing interactive.
- **Viewer**: a single-file web app (React, zustand) built into `dist/viewer.html`; `bake` injects a request into it, and the server serves it as is.
- **Shipped agent skill**: `skills/annoquest/SKILL.md`, the procedure for an agent building a request.
- Asked and not built: MCP server (the primitives are already JSON-in/JSON-out and `toElicitation` exists; adding it needs no core change), encrypted `ntfy` sink (zero-config autosubmit through a third party; see Open questions), browser extension, rewriting proxy.

## Guidance UX (from the research)

- One primary action, **Next**, walking items by priority, then document order. Within a tier, quick items (`read`, `noted`) come first: progress that starts fast reduces drop-off.
- Tiers are the two-level disclosure: the current tier expanded, later tiers collapsed with their counts; nothing is hidden without a count. Per-tier progress, and a pause point at the end of each tier ("the must-dos are done — keep going?").
- The card shows the passage itself, not only a pointer to it (a "read" tick is weak evidence of reading).
- Blocking answers ask for a reason; every preset has a neutral escape ("not my area").
- The save state is always visible and honest: *saved on this device*, *sent*, *will send when online*, *sign in again*.

## Open questions

- **Zero-config autosubmit.** The only autosubmit that needs neither setup nor a server of one's own is a public relay such as ntfy.sh, with the payload encrypted in the browser under a key carried in the link fragment. It keeps messages only hours and its operator sees metadata. v1 ships `local` (reply link + download) as the default and `http` for real autosubmit; an encrypted-relay sink is the next sink if wanted.
- **Multiple rounds** (Delphi-style: show the aggregate, let people revise) fit the model as a `round` field; not built.
