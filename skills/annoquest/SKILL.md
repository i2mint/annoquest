---
name: annoquest
description: Build a guided annotation request with annoquest — give someone documents plus a prioritised list of passages to read, check off, agree or disagree with, sign off, label or comment on, then collect their answers into an aligned / to-discuss / blocked / waiting summary. Use when asked to "get X to review / read / sign off / check / annotate this doc", "track where we are aligned", "ask them to confirm these points", "send a read-and-acknowledge", "collect structured feedback on a document", or to turn a list of questions about a document into something a person can answer in a browser.
---

# annoquest — making a guided annotation request

A request is JSON: documents, plus items that each point at a passage, ask one thing, and say how to answer. The reader opens one link and is walked through the items, most important first. You collect what comes back.

## 1. Decide the items (this is the real work)

- **One question per item.** Split "is the timeline and budget OK?" into two.
- **Priority is a promise of the reader's time.** `must`: 3–5 items at most, the ones you cannot act without. `should`: useful. `could`: only if they have time. The guide shows `must` first and folds the rest.
- **Pick the response type for what you will do with the answer.** `read` (just confirm reading), `noted` (read, with "I have a question"), `agree` (alignment), `implement` (done / will / discuss / won't), `approve` (sign-off), `consent` (unblock a decision), `comment` (open), `label` (categorise; define options). Non-technical readers: `read` / `noted` only.
- **Word the options for the item** with `labels` (`{"agree": "Realistic", "reservations": "Tight but OK", "disagree": "Unrealistic"}`): item-specific wording gets better answers.
- **Different readers, different lists**: `readers: [{id, name, email}]` and `item.readers: ["id"]`, or one request per reader.
- Add `title` (short), `prompt` (the question), and `minutes` when reading takes a while.

## 2. Anchor each item

- `target.section`: an element id in the document (a section, a `<details>`, a heading). Cheapest and most stable.
- `target.quote`: `{exact, prefix?, suffix?}` copied from the document **as served** (the HTML text, not a Markdown source; curly quotes and dashes are folded for you). Keep `exact` to the words that matter (a clause or sentence); add a prefix/suffix only when the words occur more than once.
- Both together: the quote is searched inside the section first.

## 3. Check, then deliver

```bash
annoquest create draft.json --out request.json        # ids + defaults; fails with the exact field that is wrong
annoquest check request.json --doc main=./page.html   # every passage resolves exactly once, or it says how to fix it
annoquest check request.json --doc main=./page.html --write   # record passage hashes (answers go stale if the text changes)
```

Then one of:

- `annoquest bake request.json --inline --out review.html` — one file, nothing else needed; the reader's answers stay in their browser and they send back a reply link.
- `annoquest link request.json --viewer <viewer url> [--reader id]` — the request rides in the link (keep under ~2000 characters for email; `tier` says).
- A request with `"sink": {"kind": "http", "url": "/api"}` served by an annoquest server — answers autosubmit, identity comes from the gateway. Link: `<server>/#r=…` (from `annoquest link`), or `<server>/?spec=/api/requests/<id>` once the request is registered.

Never send the link yourself unless you were asked to: hand it to the person who asked.

## 4. Collect

```bash
annoquest collect <reply-link | responses.json | server-data-dir>... --request request.json --format markdown
```

Worst first: blocked (someone said no; read their reason), to discuss, waiting (who has not answered), aligned. `stale` marks answers given to a passage that has since changed. Report the blocked and to-discuss items with the reader's comments; do not average them away.

## Gotchas

- A quote copied from a Markdown export may differ from the served HTML (newer text, different numbers). Check against the exact file the request points at, and pin a dated snapshot if the document is being edited.
- `check` exits 1 on any failed anchor: fix it, do not ship it. An unanchored item still works (it shows its prompt), so use no target when the question is about the whole document.
- One question in `must` that takes 20 minutes is worse than three that take one each. Put long reads in `should`.
