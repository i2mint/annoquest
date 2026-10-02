# annoquest

Guided annotation requests, agent-first. Give a reader one or more documents and a prioritised list of things to read, check and answer; they get one link, are walked through the most important items first, and every answer is saved as they give it (and, with a server, sent automatically). You, or your agent, collect the answers and see what is aligned, what needs discussing, what is blocked and what is still waiting.

```bash
npm i -g annoquest            # or: npx annoquest …
annoquest bake request.json --inline --out review.html     # one self-contained page: send it, host it anywhere
annoquest collect answers/ --request request.json --format markdown
```

A request is plain JSON (the Zod schema in [`src/spec.ts`](src/spec.ts) is the source of truth; `annoquest schema` prints it as JSON Schema):

```json
{
  "title": "Pilot plan: please review",
  "requester": { "name": "Ada" },
  "readers": [{ "id": "sam", "name": "Sam" }],
  "documents": [{ "id": "plan", "source": { "kind": "url", "url": "pilot-plan.html" } }],
  "items": [
    { "title": "Skim the goals", "prompt": "Read the two goal paragraphs.", "priority": "must", "response": "read", "target": { "section": "goals" } },
    { "title": "Timeline", "prompt": "Is two weeks realistic for three sites?", "priority": "must", "response": "agree",
      "labels": { "agree": "Realistic", "reservations": "Tight but OK", "disagree": "Unrealistic" },
      "target": { "section": "timeline", "quote": { "exact": "ship the pilot to three sites in two weeks" } } }
  ]
}
```

## What the reader gets

The document on the left with every asked-about passage highlighted, a guide on the right. One main button (**Next**), the current priority tier open and the later ones folded with their counts, the passage itself shown in the card, a reason asked for whenever an answer blocks, and a neutral "not my area" in every opinion preset. They can select any other passage and comment on it. The save state is always visible: *saved on this device*, *sent*, *will send when back online*, *sign in again*.

## Response types

Built-in presets (`annoquest presets`), each option tagged with a tone (positive, neutral, attention, blocking) so collection works the same for all of them:

| Preset | Options |
|---|---|
| `read` | I've read this |
| `noted` | Noted · I have a question |
| `agree` (default) | Agree · Agree, with reservations · Let's discuss · Disagree · Not my area |
| `consent` | Good enough for now · Concern, but go ahead · Objection · Stand aside |
| `implement` | Already implemented · Will implement · Let's discuss · Won't implement · Not my area |
| `approve` | Approve · Approve with changes · Changes required · Not relevant to me |
| `gradient` | Kaner's eight gradients of agreement |
| `fist-to-five` | 0 to 5 |
| `moscow` | Must · Should · Could · Won't (this time) |
| `comment` | a free comment |
| `label` | your own categories (define `options`) |

Override the wording per item with `labels` (item-specific wording gets better answers than generic agree/disagree), or define new types in the request's `responseTypes`.

## Delivery, storage, sinks: the seams

| Seam | Default (no server) | Also built in |
|---|---|---|
| Document source | `inline`: `bake --inline` snapshots the HTML into the page | `url`: a live page; same-origin gets highlights, cross-origin shows the passage with a `#:~:text=` link |
| Delivery | a baked HTML file | `annoquest link`: the request in the link fragment (`#r=`), or `?spec=<url>` to a hosted JSON |
| Device storage | localStorage, through a zodal `DataProvider` | any `DataProvider` |
| Sink | `local`: answers stay on the device; the reader sends a reply link or a file | `http`: autosubmit to an annoquest server (`"sink": {"kind": "http", "url": "/api"}`) |
| Identity | self-declared (`?reader=` in the link, or a name) | server-asserted, from a forward-auth header |

See [docs/design.md](docs/design.md) for why, and [docs/research/](docs/research/) for the prior art and the browser techniques behind it.

## CLI

```text
annoquest create <input.json> [--out request.json]           fill ids and defaults, validate
annoquest check <request.json> [--doc id=path|url]... [--write]
annoquest bake <request.json> [--out page.html] [--doc id=path|url]... [--inline]
annoquest link <request.json> --viewer <url> [--reader id] [--spec-url url]
annoquest collect <file|dir|reply-link>... --request <request.json> [--format json|markdown]
annoquest elicit <request.json> <item-id>                     one item as an MCP elicitation schema
annoquest presets | schema [request|responses]
```

Output is JSON on stdout; errors are `{"error": {"code", "message"}}` on stderr with a non-zero exit. `check` (and `bake`, unless `--no-check`) refuses a request whose passages are missing or ambiguous, and says how to fix each one.

## Library

```ts
import { createRequest, checkRequest, bakeRequest, requestLink, summarize, summaryMarkdown } from 'annoquest';
```

Every function is plain data in, plain data out; the CLI is a thin wrapper.

## The server adapter (optional)

For real autosubmit and server-asserted identity, run the small Python app in this repo behind any gateway that overwrites an identity header:

```bash
pip install "annoquest-server[server] @ git+https://github.com/i2mint/annoquest"
ANNOQUEST_IDENTITY_HEADER=X-Forwarded-User uvicorn annoquest_server:mk_app --factory
```

**Open a request's link yourself before sending it**: that registers it (only its sender can), and the viewer shows a preview banner so nothing you click is sent. It serves the viewer at `/`, stores each request once and every save as a new file (`requests/<id>.json`, `responses/<id>/<reader>/<stamp>.json`, no emails in paths), lets a request's listed readers and its requester in, and lets only the requester read everyone's answers. `ANNOQUEST_DOCS_DIR` serves a folder at `/doc/` so documents are same-origin with the viewer. Collect by pointing `annoquest collect` at the data directory. See [annoquest_server/README.md](annoquest_server/README.md).

## For agents

`skills/annoquest/SKILL.md` is the procedure for building a request (pick items, anchor them, choose response types, check, deliver, collect). Install it with `gh skill install i2mint/annoquest annoquest`, or read [llms.txt](llms.txt).

## License

MIT
