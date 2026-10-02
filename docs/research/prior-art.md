# Guided annotation requests — prior art and recommendations

Research report 01 (prior art), 2026-10-02. Scope: a TypeScript npm package where an agent builds a *request* (context + documents + prioritised items, each anchored to a section or highlight, with a prompt and a response type); a reader opens a link, is guided through the items, and responses autosave and autosubmit; the requester collects and sees where people are aligned. Licences and package versions were checked against npm and GitHub on 2026-10-02. Claims I could not confirm from a primary source are marked **[unverified]**.

## Summary and recommendation

1. **Nothing found does the whole job.** Annotation overlays (Hypothesis, Recogito) give anchoring and highlights but no requester-authored, prioritised item queue. Review tools (Ziflow, Filestage, Approvals for Confluence, Comala Read Confirmations) give sign-off states and per-section approvers but are closed SaaS with no agent surface. HITL agent primitives (MCP elicitation, LangGraph `interrupt`, A2A `input-required`, gotoHuman) give "agent asks a human, gets structured data back", but not anchored to a document, not asynchronous across several people, and not guided. The gap is real, and the package should be **the join between these three families**, not a re-implementation of any of them.
2. **Anchoring: depend on small MIT/BSD pieces and do not adopt a whole annotation client.** Emit W3C Web Annotation selectors (TextQuote + TextPosition + a section-level CssSelector/FragmentSelector) [1]. For rendering highlights and the reader's own selections, **depend on `@recogito/text-annotator` (BSD-3, active, has a W3C adapter, `scrollIntoView`, `setFilter`, `setStyle`)** [10]. For re-anchoring after the document changes, **depend on `approx-string-match` (MIT)** [7] and port the scoring of Hypothesis's `match-quote.ts` (BSD-2, keep the attribution) [6]. **Study, do not run, the Hypothesis client**: it assumes an `h` annotation service and its own accounts and sidebar [3][9].
3. **Attachment modes, in order:** (a) a script-tag overlay on pages we control (for example a technical design document behind a company login, served from the same origin as the guide), the default; (b) a "frame" viewer that loads a same-origin or CORS-readable page; (c) a proxy adapter in the style of Hypothesis Via [5], as a later seam only. The browser-extension route (Diigo, Glasp, Hypothesis) is wrong for non-technical readers who should only have to click a link.
4. **Response types: a small core of kinds (`ack`, `choice`, `multi`, `scale`, `text`) plus named presets.** Every choice option carries a *tone* (`positive | neutral | attention | blocking`), so that one generic aggregation rule (adapted from Reviewable, Ziflow, Google Drive approvals and IESG) works for every preset. Proposed presets: `read`, `noted`, `agree`, `consent`, `implement`, `approve`, `gradient` (Kaner 8-point), `fist-to-five`, `moscow`, `comment`, `label`. Prefer item-specific wording over generic agree/disagree, which survey research shows yields lower-quality answers [52].
5. **Invalidate on change.** GitHub's "Viewed" box unticks itself when the file changes [28]. Google Drive approvals need re-approval after any edit [32]. Comala and Approvals for Confluence re-request confirmation on edit [35][36]. Store a hash of each anchored passage with every response and mark the response `stale` when the hash no longer matches.
6. **Guidance: one primary "Next" action, tiers that are visible but collapsed, progress counted per tier.** Choice overload only appears under certain conditions (hard tasks, complex sets, uncertain preferences) [56][57], and those conditions match a non-technical reader facing a long doc, so stage the items with at most two disclosure levels [58]. Put quick items first: fast-then-slow progress reduces drop-off, slow-then-fast increases it [62]. Use READ-DO cards for novices and DO-CONFIRM summaries for experts [60].
7. **Tours: do not depend on Shepherd.js (AGPL-3.0 since v14; the last MIT release is 13.0.3) or Intro.js (AGPL-3.0).** Driver.js and React Joyride are MIT [65][68], but the guide is really a side panel with a queue rather than a tour, so build it ourselves and use Driver.js at most for the spotlight effect.
8. **Agent surface: make every response type expressible as an MCP form-elicitation schema** (a flat object of primitives and enums with `oneOf` titles) [70]. That gives an inline in-chat fallback for one or two quick items at no extra cost. Model the request lifecycle on A2A task states [73]. Treat MCP URL-mode elicitation [70] and MCP Apps [71] as later surfaces.
9. **Zero-server default:** keep the request spec and responses client-side (localStorage/IndexedDB), with autosubmit on `visibilitychange` through `sendBeacon` [90]. To share with no trusted server, use an encrypted blob plus a key in the URL fragment, which is the Excalidraw pattern [89] and fits the [holdall](https://github.com/i2mint/holdall) seam.
10. **Read-and-acknowledge does not prove reading** (98% missed a planted clause [85]). For `read`/`noted` items, show the passage inside the guide card and keep it short.

## 1. Web annotation tools and overlays

### 1.1 Comparison

| Tool | What it is | How it attaches to a page | Licence / status | Verdict |
|---|---|---|---|---|
| **Hypothesis client** [2][3][4] | Full annotation sidebar plus highlighter, W3C-style selectors, groups, replies | (1) script tag `https://hypothes.is/embed.js`, configured by a JSON `<script class="js-hypothesis-config">` block (`openSidebar`, `showHighlights`, `services` with `apiUrl`/`authority`/`grantToken`, `externalContainerSelector`, `requestConfigFromFrame`, `groupsAllowlist`, `theme`) [3]; (2) browser extension; (3) bookmarklet; (4) the Via proxy [4] | BSD-2-Clause, very active (pushed 2026-09-29) | **Study** (anchoring, config model). **Avoid** as a runtime: it needs the `h` service [9] or a compatible API, and brings its own accounts and sidebar UX |
| **Hypothesis Via** [5] | Proxy that serves `https://via.hypothes.is/<url>` with the client injected; PDFs go through a modified PDF.js | Server-side proxy that rewrites the page (HTML goes to a separate "ViaHTML" proxy) | BSD-2-Clause | **Study** as the template for an optional proxy adapter |
| **Hypothesis anchoring code** (`src/annotator/anchoring/`: `html.ts`, `match-quote.ts`, `text-range.ts`, `xpath.ts`, `types.ts`, `pdf.ts`) [6] | Converts between DOM `Range` and Range/TextPosition/TextQuote selectors, with fuzzy re-anchoring | Library code inside the client | BSD-2-Clause | **Wrap/port** `match-quote.ts` (≈150 lines) with attribution |
| **approx-string-match** [7] | Myers bit-parallel approximate string search, by Hypothesis's Robert Knight | npm library | MIT, v2.0.0 (2022), stable | **Depend** |
| **@recogito/text-annotator** [10] | Text highlighting/annotation layer for any DOM element: `createTextAnnotator(el)`, events, `loadAnnotations`, `scrollIntoView`, `setFilter`, `setStyle`, `setAnnotatingEnabled`, undo/redo; React, TEI and PDF packages; W3C adapter (`w3c-text-format-adapter.ts`) | Library you mount on an element (script/bundle), no server | BSD-3-Clause, v4.3.6 published 2026-10-01 | **Depend** (rendering highlights and the reader's selections). Its native selector is `{quote, start, end}`, and the W3C adapter converts it |
| **RecogitoJS** (`@recogito/recogito-js`) [11] | Predecessor of text-annotator | Library | BSD-3, **archived** | **Avoid** (superseded) |
| **Annotorious** [12] | Image annotation (rectangle, polygon…), OpenSeadragon/IIIF, React, W3C output | Library mounted on an `<img>` or viewer | BSD-3, v3.9.3 (2026-09) | **Depend later**, for an image/figure document adapter |
| **Annotator.js** (Open Knowledge) [13] | The 2010s ancestor of Hypothesis's client | Script/jQuery plugin | MIT or GPL-3.0 dual; last release v2.0.0-alpha.3 (2015) | **Avoid** (dead) |
| **Apache Annotator** (`@apache-annotator/dom`, `selector`) [14] | Clean implementations of TextQuote/TextPosition/CSS/Range selector matching | Library | Apache-2.0; npm 0.2.0 (2022); repository **archived** (archived 2025-08 per repo notice, last push 2024-06) | **Study** (clean reference code); do not depend |
| **dom-anchor-text-quote / -text-position** [15] | Randall Leeds's small selector libraries (used by early Hypothesis) | npm libraries | MIT, last release 2022 | **Study**; prefer approx-string-match plus our own wrapper |
| **Diigo** [17] | Personal/social bookmarking, highlights, sticky notes, "Outliner" | Browser extension; "Diigolet" bookmarklet for other browsers | Proprietary SaaS | **Avoid** (extension-only, personal-research oriented) |
| **Glasp** [18] | Social web highlighter, export to notes apps | Browser extension (plus mobile apps) | Proprietary | **Avoid** |
| **Marker.io** [19] | Visual bug reporting with screenshots, synced to Jira/Linear and similar | JS snippet widget (`window.Marker` SDK; guests need no account) or browser extension | Proprietary | **Study**: snippet plus guest identity prefill (`reporter` fields) is a good UX model |
| **BugHerd** [20] | Pin feedback to DOM elements, kanban | JS snippet in `<head>` (recommended; required on mobile) or extension; guests must log in | Proprietary | **Study** (element pinning; shows the friction of a login requirement) |
| **Pastel** [21] | Comment on live sites, images, PDFs; "canvases" reachable by link, no login for commenters | Shareable canvas URL wrapping the live site (proxy-style) **[unverified: exact proxy vs iframe mechanism]** | Proprietary | **Study**: the "no login to comment" link is the UX target |
| **ruttl** [22] | Website feedback plus live CSS edits, guest links without signup | Paste a URL and the page is served through a `*.proxy.ruttl.com` subdomain (observed in search results), i.e. a rewriting proxy | Proprietary | **Study** (proxy pattern) |
| **MarkUp.io** [23] | Comment on websites, PDFs, images | Paste a URL into the app (now a proxy; older versions scraped a snapshot) or use the Chrome extension | Proprietary | **Study** |
| **Filestage** [24] | Review and approval of files, videos and websites in reviewer *groups/steps* with due dates | Upload, or a URL for websites | Proprietary | **Study** decision vocabulary (Approve, Request changes, optional Approve-with-changes and Reject) and sequential reviewer groups |
| **Ziflow** [25][26] | Online proofing incl. live-website proofs, multi-stage (Creative → Brand → Legal) | URL proof (screenshots plus live view) | Proprietary | **Study** decision vocabulary and the explicit *decision calculation* rule |

### 1.2 Anchoring: what to copy

The W3C Web Annotation Data Model (Recommendation, 2017) is the interchange target: an annotation has `body` and `target`, the target uses a `selector`, and the `motivation` vocabulary includes `assessing`, `commenting`, `questioning`, `tagging`, `classifying`, `highlighting` and others [1]. The working rules are standoff annotation only (never modify the document), multiple fallback selectors, and provenance on every annotation. This package should emit, for every anchored item:

- a **section anchor** (element id → `FragmentSelector`/`CssSelector`), which is stable on documents whose HTML has stable section anchors;
- a **TextQuoteSelector** (`exact`, `prefix`, `suffix` of about 32 characters each) for highlights;
- a **TextPositionSelector** (`start`, `end`) as a position hint;
- a **content hash** of the anchored passage, for staleness (§2).

Hypothesis's `matchQuote` shows how to re-anchor when the text has drifted. It first tries exact `indexOf` matches. If none are found, it runs `approx-string-match` with an error budget, then scores each candidate as a weighted sum: **quote similarity ×50, prefix ×20, suffix ×20, position proximity ×2 (tie-breaker)**, normalised by the maximum score [6][7]. Background on the approach is in Hypothesis's "Fuzzy Anchoring" post [8]. This is small, well-tested code under a permissive licence, and the right base for our `anchor()` function.

**Text fragments** (`#:~:text=[prefix-,]start[,end][,-suffix]`) [16] are worth emitting as a *deep link for "open in the original page"* that needs no overlay. They have two limits: the spec is still a WICG draft (supported in Chromium and Safari, Firefox later **[unverified: current Firefox status]**), and the directive is deliberately **hidden from page JavaScript**, so the overlay cannot read it. They are a fallback link format, not an anchoring mechanism.

### 1.3 Attachment modes: verdict

| Mode | Examples | Pros | Cons | Use |
|---|---|---|---|---|
| Script-tag overlay | Hypothesis `embed.js`, BugHerd, Marker.io | Full DOM access, no install for reader | Needs control of the page (or its host) | **Default** (the document host is under our control) |
| Viewer + iframe of target | Pastel-style canvas **[unverified]** | Works with any same-origin or CORS-readable page; our UI stays outside the page | Cross-origin iframes are opaque to scripts | **v1 second mode** for same-origin docs; fetch-and-render (static HTML/Markdown) for others |
| Rewriting proxy | Via, ruttl, MarkUp | Works on arbitrary third-party pages | Server needed; breaks some sites; legal/ToS questions | **Later adapter** behind the document-adapter seam |
| Browser extension | Hypothesis, Diigo, Glasp, MarkUp | Any page, no server | Reader must install something, which a non-technical reader will not do | **Avoid** for readers |
| Bookmarklet | Hypothesis, Diigolet | No install | Blocked by CSP on many sites; confusing | **Avoid** |

## 2. Review, sign-off and disposition workflows

### 2.1 Comparison

| System | Response vocabulary | Aggregation / resolution rule | Behaviour when content changes | Lesson for us | Verdict |
|---|---|---|---|---|---|
| **Reviewable** [27] | Active dispositions: **Discussing** (neutral), **Blocking** (opposed to resolution, waiting on someone), **Working** (keeps it open while you work), **Satisfied** (ready to resolve), **Informing** (starts resolved, open for comment). Passive: **Following**, **Mentioned**, **Dismissed**, and **Pondering** (still thinking; drafted replies are held). Buttons: Acknowledge, Done, Resolve | Resolved when **at least one participant is Satisfied or Informing and none is Blocking or Working**; Discussing is neutral | Thread-level | The best-specified aggregation rule found. It is the template for our tone-based rule, and "Pondering" maps to our *draft* state | **Study** (copy the rule) |
| **GitHub PRs** [28][29] | Per file: **Viewed** checkbox. Per review: **Comment / Approve / Request changes**. Per thread: **Resolve conversation** (author or writer) | Branch protection can require approvals | **Viewed is unticked automatically if the file changes** | Per-item "read" plus staleness; review-level verdict separate from item-level threads | **Study** |
| **Gerrit** [30] | Code-Review **−2** "This shall not be submitted" (blocks), **−1** "I would prefer this is not submitted as is", **0** no score, **+1** "Looks good to me, but someone else must approve", **+2** "Looks good to me, approved"; Verified −1/0/+1 | Label functions: MaxWithBlock, AnyWithBlock, MaxNoBlock, NoBlock (now submit requirements) | Votes can be sticky or reset per patch set | Separates *authority* (+2 needs a role) from *opinion* (+1); veto as a distinct value | **Study** |
| **Google Docs** [31] | Comments; **assign to** via @mention plus checkbox (assignee gets an email, is responsible for marking **Done**); suggestion mode | none | Comments re-anchor on edits | Assignment of a single item to a person is a first-class idea | **Study** |
| **Google Drive approvals** [32] | **Approve / Reject**, optional lock | **Approved only when all approvers approve; rejected if any one rejects** | **Any edit requires every reviewer to re-approve** | Unanimity rule and re-approval on edit | **Study** |
| **Notion verified pages** [33] | **Verified** (until a date or indefinitely), with an owner | n/a | Expiry notifies the owner to re-verify | Time-based expiry as an alternative to hash-based staleness | **Study** |
| **Confluence** page status [34] | Rough draft · In progress · Ready for review · Verified **[names from secondary sources]** | n/a | Manual | Document-level status, distinct from per-reader responses | **Study** |
| **Comala Read Confirmations** (Confluence) [35] | **Read confirmation** click; progress bar; report of who has and has not read | n/a | **Re-request confirmation from previous assignees after an edit** | Exactly our `read` preset plus staleness | **Study** |
| **Approvals for Confluence** (AppFox) [36] | **Section approvals**: different sections go to different approvers, each with its own history; pending/approved/rejected dashboard | Per section | **Expire on edit or after a period**, with automatic re-requests | The closest existing product to "anchored items per person" | **Study** |
| **PowerDMS** [37] (also ConvergePoint, by vendor descriptions) | Policy **assignment → read → sign (attest)** with username/password or thumbprint; signature reports | n/a | New version means a new assignment | "Attestation" means a re-authenticated ack: an *identity-strength* option on `read`, needing the auth seam | **Study** |
| **Phabricator / Phorge** [38] | Accept · Request Changes · Resign · Commandeer; inline comments with a "Done" mark **[unverified exact labels]** | Reviewer-based | Per diff | Phabricator ended maintenance 2021-06-01 (Phorge continues it) | **Study** only |
| **Oxide RFDs** [39] | Document states: **prediscussion · ideation · discussion · published · committed · abandoned**; discussion via PR, 3–5 business days | Author merges after discussion converges | Published RFDs still editable | A request needs a *deadline* and the document needs a *lifecycle state* separate from responses | **Study** |
| **IETF** [40][41] | Rough consensus; humming "not votes". IESG ballot positions: **Yes · No Objection · Discuss · Abstain · Recuse** | "Rough consensus is achieved when all issues are addressed, but not necessarily accommodated" [40]; a DISCUSS blocks until cleared | New revision; DISCUSS re-examined | "No Objection" (I don't block, not necessarily endorse) and "Recuse" (not my area) are values our presets lack without it | **Study** (adopt the values) |
| **Google / Uber design docs** [42][43] | Reviewers plus a named **approvers** list (Uber RFC template); Google docs reviewed by comment threads, larger ones in review meetings | Approvers sign off | Living docs | Distinguish *reviewers* (opinion) from *approvers* (authority), as Gerrit does | **Study** |
| **Fagan inspection** [44] | Roles (moderator, author, reader, tester), stages (planning, overview, preparation, meeting, rework, follow-up), checklists of defect types | Moderator verifies rework | Follow-up stage | Structured preparation with checklists; follow-up as an explicit stage | **Study** |
| **Apache voting** [45] | **+1 / ±0 / −1**; a −1 on code is a veto and **must carry a justification**, otherwise it is void; lazy consensus ("silence gives assent") | 3 × +1 and no −1 (non-lazy) | n/a | *Blocking responses require a reason*; lazy consensus as an optional closing rule (deadline reached with no objection counts as consent) | **Study** (adopt both) |
| **Conventional Comments** [46] | Labels praise · nitpick · suggestion · issue · todo · question · thought · chore · note; decorations (blocking) · (non-blocking) · (if-minor) | n/a | n/a | A ready vocabulary for the *kind* of a free comment, plus a blocking flag | **Study**; offer as optional comment tags |

### 2.2 What this implies for the data model

- **Two levels**: item-level responses and an optional request-level verdict, as GitHub has (file "Viewed" plus review verdict) and Ziflow has (per-comment plus proof decision).
- **Tone on every option**, so that aggregation is a single generic function. Combining Reviewable, Ziflow, Google Drive and IESG gives: an item is **blocked** if anyone chose a `blocking` option; else **needs discussion** if anyone chose an `attention` option; else **aligned** if at least one required responder chose `positive` and every required responder has responded; else **pending**. `neutral` (abstain / not my area / recuse) neither blocks nor counts as endorsement, like Reviewable's "Discussing" and IESG's "Abstain/Recuse".
- **Blocking needs a reason** (Apache [45], sociocracy [50]). A `blocking` option has `requiresComment: true` by default.
- **Staleness**: store `anchorHash` with each response. A response whose hash no longer matches is `stale`, shown to the requester, and re-queued for the reader (GitHub [28], Drive [32], Comala [35], AppFox [36]).
- **Authority vs opinion** (Gerrit +1/+2, Uber approvers [42]): a per-recipient `role: 'approver' | 'reviewer' | 'informed'` on the request lets the rule count only approvers toward "aligned".
- **Draft vs submitted**: Reviewable's "Pondering" [27] and Argilla's draft/submitted/discarded [79]. With autosubmit, "draft" means *saved locally, not yet synced*, and nothing should hold back submission.

## 3. Response scales and alignment vocabularies

### 3.1 Survey of scales

| Scale | Values | Strength | Weakness | Fit |
|---|---|---|---|---|
| **Kaner's Gradients of Agreement** [47] | 1 Endorsement "I like it" · 2 Endorsement with a minor point of contention "Basically I like it" · 3 Agreement with reservations "I can live with it" · 4 Abstain "I have no opinion" · 5 Stand aside "I don't like this, but I don't want to hold up the group" · 6 Formal disagreement, but willing to go with majority · 7 Formal disagreement, with request to be absolved of responsibility for implementation · 8 Block "I veto this proposal" | Separates *liking* from *blocking*; shows lukewarm support that a yes/no hides | Eight options is heavy for a non-technical reader | `gradient` preset (opt-in) |
| **Fist-to-five** [48] | 0 fist = no/block … 3 "can live with it" … 5 enthusiastic; consensus if all ≥3 | Fast, numeric, aggregates trivially | Meanings vary by group | `fist-to-five` preset |
| **Delphi** [49] | Not a scale but a protocol: **anonymity, iteration, controlled feedback, statistical group response** over several rounds | Converges expert opinion without groupthink | Needs rounds and a facilitator | **Later feature**: "round 2" shows the aggregate and lets people revise (seam: the request has `round`) |
| **Consent / sociocracy** [50] | Consent · **Objection** (must be reasoned: the proposal is outside your range of tolerance / harms the aim); criterion "good enough for now, safe enough to try" | Low bar to move forward; objections become improvements | Needs facilitation to resolve objections | `consent` preset |
| **IETF / IESG** [40][41] | Yes · No Objection · Discuss · Abstain · Recuse | "No Objection" and "Recuse" are useful neutral values | Domain-specific labels | Values folded into `agree`/`approve` |
| **Apache** [45] | +1 · ±0 · −1 (veto with reason) | Very simple | Coarse | `vote` alias of fist-to-five or agree |
| **Likert** [51] | 5 or 7 points, strongly disagree → strongly agree | Familiar; analysable | **Agree/disagree formats give lower-quality answers than item-specific options**, because of acquiescence bias [52] | Use only for `scale`; prefer item-specific wording |
| **MoSCoW** [53] | Must · Should · Could · Won't (this time) (Clegg, Oracle, 1994; DSDM) | Prioritisation by the reader | It ranks, it does not judge agreement | `moscow` preset (e.g. "how important is this to you?") |
| **ADR statuses** [54][55] | Nygard: Proposed · Accepted · Deprecated · Superseded; MADR adds Rejected | Standard decision lifecycle | Document-level, not per-reader | **Request/item lifecycle**, not a response type: after collection, the requester can mark an item "accepted" |
| **RACI-adjacent sign-off** (from Ziflow [25], Filestage [24], Drive [32]) | Approve · Approve with changes · Changes required · Reject · Not relevant | Matches business sign-off; Ziflow publishes its aggregation | Too formal for alignment chats | `approve` preset |

### 3.2 Recommended presets

Core *kinds* (the Zod discriminated union): `ack` (a single checkbox), `choice` (single select), `multi` (multi-select), `scale` (numeric range with labelled ends), `text` (free text). Any item may additionally allow an optional comment. Presets are named, data-only configurations of a kind; the requester or agent can define new ones in the same shape.

| Preset | Kind | Options (value · label · tone) | Typical use |
|---|---|---|---|
| `read` | ack | `read` · "I've read this" · positive | Read-and-acknowledge; requests to a non-technical reader |
| `noted` | choice | `noted` · "Noted" · positive; `question` · "I have a question" · attention (comment required) | Non-technical read with an escape hatch |
| `agree` | choice | `agree` · "Agree" · positive; `agree-with-reservations` · "Agree, with reservations" · positive (comment encouraged); `discuss` · "Let's discuss" · attention; `disagree` · "Disagree" · blocking (comment required); `no-opinion` · "No opinion / not my area" · neutral | Default alignment |
| `consent` | choice | `consent` · "Good enough for now" · positive; `concern` · "Concern, but go ahead" · attention; `object` · "Objection" · blocking (reason required); `stand-aside` · "Stand aside" · neutral | Decisions you want to unblock fast |
| `implement` | choice | `done` · "Already implemented" · positive; `will` · "Will implement" · positive; `wont` · "Won't implement" · blocking (reason required); `discuss` · "Let's discuss" · attention | Implementation status checks ("implemented / will implement / should discuss") |
| `approve` | choice | `approve` · "Approve" · positive; `approve-with-changes` · "Approve with changes" · positive (comment required); `changes` · "Changes required" · blocking; `not-relevant` · "Not relevant to me" · neutral | Sign-off |
| `gradient` | choice | Kaner's 8 levels: 1–3 positive, 4–5 neutral, 6 attention, 7 attention, 8 blocking | High-stakes decisions |
| `fist-to-five` | scale 0–5 | 0 blocking, 1–2 attention, 3–5 positive | Quick temperature check |
| `moscow` | choice | Must · Should · Could · Won't (this time); tone neutral (this is a ranking) | Asking the reader to prioritise |
| `comment` | text | — | Open feedback; optional Conventional-Comments tag [46] |
| `label` | choice/multi | requester-defined categories, tone neutral | Data labelling of a document |

Design rules: (i) **write item-specific option labels where possible** ("Is the 2-week pilot realistic?", options "Realistic / Tight but OK / Unrealistic") rather than generic agree/disagree [52]. The preset gives the tones, and the item may override the labels. (ii) **Blocking options require a reason** [45][50]. (iii) **Always include a neutral escape option** ("not my area"), following IESG's Abstain/Recuse [41] and Kaner's Abstain [47], so readers do not pick a fake opinion. (iv) Keep the default preset at ≤5 options. (v) Presets are plain data and must survive conversion to an MCP elicitation enum with `oneOf` titles (§5).

## 4. Guidance UX and priority

### 4.1 Evidence

| Finding | Source | Design implication |
|---|---|---|
| Choice overload: mean effect ≈ 0 across 50 experiments, high variance [56]; significant once moderators are included: task difficulty, choice-set complexity, preference uncertainty, an effort-minimising goal [57] | Scheibehenne et al. 2010; Chernev et al. 2015 | A non-technical reader facing a long technical doc meets all four moderators, so **stage** the items rather than show 30 at once |
| Progressive disclosure: show the most important options first; "the very fact that something appears on the initial display tells users that it's important"; avoid more than 2 levels [58] | Nielsen Norman Group | Two levels: *now* (current tier, expanded) and *later* (other tiers, collapsed with counts). Never hide items without a count |
| Working memory holds about 4 chunks [59] | Cowan 2001 | First tier ("Must") capped at 3–5 items by default (heuristic, not a hard rule) |
| Checklists: READ-DO (follow step by step) vs DO-CONFIRM (do from memory, then confirm); keep them short, built around pause points [60]. The WHO 19-item surgical checklist cut deaths from 1.5% to 0.8% and complications from 11.0% to 7.0% [61] | Gawande 2009; Haynes et al. 2009 | READ-DO mode for novices (one card at a time, Next). DO-CONFIRM mode for experts (the full list, tick what you agree with, then review what's left). Tier boundaries are the pause points |
| Progress indicators: a constant indicator does not reduce drop-off; **fast-to-slow reduces it, slow-to-fast increases it** (32 experiments) [62] | Villar, Callegaro & Yang 2013 | Order quick items (`read`, `noted`) before heavy ones within a tier; show progress per tier, not one global bar that crawls |
| Goal gradient: effort rises as the goal nears [63]; endowed progress: a head start roughly doubles completion [64] | Kivetz et al. 2006; Nunes & Drèze 2006 | "2 of 3 must-dos done" per tier. A first trivial item (e.g. "skim the summary — Read") gives honest early progress. Do not fake progress |
| Read-and-acknowledge is weak evidence of reading: 74% skipped the policy; mean reading times 73 s / 51 s; 98% missed planted clauses [85] | Obar & Oeldorf-Hirsch 2018 | For `read` items, put the actual passage (or a ≤3-sentence excerpt) in the card; offer an optional "one-line takeaway" field; record time-on-item as provenance, not as proof |

### 4.2 Guided-tour libraries

| Library | Licence (npm, 2026-10-02) | Notes | Verdict |
|---|---|---|---|
| **Driver.js** [65] | MIT, v1.8.0 | Highlight plus popover, framework-agnostic, small | **Depend (optional)** for the spotlight effect on the current anchor |
| **React Joyride** [68] | MIT, v3.2.0 | React-only step tours | Study |
| **@reactour/tour**, **NextStep.js**, **Onborda** | MIT | React/Next tours | Study |
| **Shepherd.js** [66] | **AGPL-3.0** (v15.3.0) with a paid commercial licence; **13.0.3 was the last MIT release** | Mature | **Avoid** (copyleft would contaminate a public MIT package; the old MIT version would freeze us in time) |
| **Intro.js** [67] | **AGPL-3.0** (v8.6.0) with a commercial licence (AGPL since at least 2.9) | Mature | **Avoid** |

Tours are the wrong mental model anyway: a tour is linear and dismissible, while our guide is a *queue with state* the reader returns to over days. Build the guide panel ourselves (schema-driven UI with shadcn) and use Driver.js-style spotlighting only for "jump to anchor".

### 4.3 Recommended guidance pattern

- **One primary action**: a "Next item" button that walks the queue in priority order, then by document order within a priority. Everything else is secondary.
- **Tiers** derived from item priority (default labels "Must", "Should", "If you have time"; configurable): the current tier is expanded, other tiers are collapsed with counts ("4 more, optional"). This keeps disclosure to 2 levels [58].
- **Two reading modes** chosen by the requester per recipient: *guided* (READ-DO; one card, document scrolls to the anchor) and *checklist* (DO-CONFIRM; full list beside the doc). For example, an implementer gets checklist mode, and a non-technical executive gets guided mode with `read`/`noted` only.
- **Per-tier progress** and a final "pause point" summary per tier ("You've done the must-dos. Want to keep going?"), which gives an honest place to stop.
- **Estimated time** per item and per tier (requester-supplied or derived from passage length); keep a request under about 60 minutes of reading, by analogy with code-review fatigue findings [86] **[extrapolated from code review to documents]**.
- **Unrequested annotations**: let the reader select any text and comment (Recogito does this), filed as "extra" so it never competes with the queue.

## 5. Human-in-the-loop request primitives for AI agents

| Primitive | Shape | Async / multi-person? | Anchored to a doc? | Lesson | Verdict |
|---|---|---|---|---|---|
| **MCP elicitation, form mode** [69][70] | Server sends `elicitation/create` with `message` and `requestedSchema`: a **flat object of primitives** (string with format email/uri/date/date-time, number/integer, boolean, enum; 2025-11-25 adds titled enums via `oneOf`/`anyOf` with `const`/`title`, multi-select arrays and `default`s). Reply `action: accept / decline / cancel` | Synchronous, same user, inside a client session | No | Our response types should compile to this subset, giving a free inline surface for 1–2 quick items. Copy the **accept/decline/cancel** distinction (decline = "won't answer", cancel = "dismissed") | **Wrap** (emit compatible schemas; serve as an MCP tool) |
| **MCP elicitation, URL mode** (2025-11-25) [70] | `mode: "url"`, `url`, `elicitationId`; out-of-band browser interaction; optional `notifications/elicitation/complete`; error `-32042 URLElicitationRequiredError` | Asynchronous, but the spec binds it to *the same user* as the MCP client | No | Shape matches "open this link, I'll be notified when done" for the requester's *own* review; not meant to route a request to a third person | **Study**; maybe a later surface for self-review |
| **MCP Apps** (official extension, 2026-01-26) [71] | Tools return `ui://` resources rendered in sandboxed iframes in Claude, ChatGPT, VS Code, Goose | Same user, in-chat | Could be | The viewer could later be served as an MCP App so the requester inspects responses in-chat | **Study** (later surface) |
| **LangGraph `interrupt()` / `Command(resume=…)`** [72] | Node pauses with a JSON payload; state is checkpointed; resume value becomes the return of `interrupt()` | Async (waits indefinitely) | No | "Request = durable pending interrupt; collect = resume with the response set" | **Study** |
| **A2A task states** [73] | submitted · working · **input-required** · **auth-required** · completed · failed · canceled · rejected | Async, agent ↔ agent | No | A ready lifecycle for our request: `draft → sent → opened → in-progress → completed → closed`, with partial results readable at any time | **Study** (align state names) |
| **OpenAI Agents SDK** [74] | `needsApproval` on tools; run returns `interruptions`; `state.approve/reject`; `RunState` serialises (`toString`/`fromString`) | Async | No | Serialisable pending state; several approvals pending at once | **Study** |
| **Claude Agent SDK `AskUserQuestion`** [75] | Model asks multiple-choice/multi-select `questions[]`; host renders them via `canUseTool` | Sync, same user | No | Closest built-in "agent asks a human" in our own toolchain; the skill shipped with the package should tell agents when to escalate from AskUserQuestion to an annotation request (several items, a document, another person, async) | **Study** |
| **HumanLayer** [76] | Formerly an SDK with approval decorators and "human as tool" across Slack/email contact channels **[API names from memory, unverified]** | Async, multi-channel | No | The repo now says "the code here is pretty much all deprecated"; the company pivoted to coding agents | **Study** history only; **avoid** |
| **gotoHuman** [77] | MCP server: `list-forms`, `get-form-schema`, `request-human-review-with-form` (form data, metadata, assigned users); managed approval UI, webhooks | Async, assigned users | No (forms, not anchored docs) | The closest commercial analogue to "agent creates a review request for a named person and gets structured data back" | **Study** (tool naming, assignment model) |
| **Label Studio** [78] | Projects, XML labeling config, tasks/annotations/predictions JSON; embeddable frontend | Async, many annotators | Yes (text spans etc.) | A rich data-labelling model; overkill as a dependency (server, Django) | **Study**; adapter target for the `label` use case |
| **Argilla** [79] | Datasets with fields and **questions** (Label, MultiLabel, Ranking, Rating, Span, Text); guidelines; `TaskDistribution(min_submitted)`; response status draft/submitted/discarded | Async, many annotators | Span questions only | `min_submitted` = "how many responses close an item"; question taxonomy matches our kinds; per-question guidelines map to item `prompt` + `help` | **Study** |
| **JSON Forms** [80] / **RJSF** [81] / **SurveyJS** [82] | Schema plus UI-schema forms; JSON Forms `Categorization` with `variant: "stepper"`, `showNavButtons` | n/a | No | Proof that schema → stepper form works; but our stack is Zod/zodal, and Zod 4 has native `z.toJSONSchema()` [83] for the MCP bridge | **Avoid** as dependencies (stack mismatch); SurveyJS form library is MIT but its Creator is commercially licensed |

**Synthesis.** The package is, in protocol terms, an **asynchronous, multi-recipient, document-anchored elicitation**. The agent primitives should mirror what agents already know:

- `createRequest(spec)` → a request id and per-recipient links;
- `getStatus(id)` → A2A-like state plus per-item aggregate;
- `collect(id)` → responses, W3C-exportable;
- `ask(item)` → the inline MCP-elicitation fallback for a single item.

Each is a function first, then exposed through CLI and MCP from the same definitions.

## 6. Other relevant findings

### 6.1 Products closest to "guided read-and-annotate request"

- **Approvals for Confluence (AppFox)** [36]: per-section approvers, expiry on edit, dashboard. Closest on *anchored items per person*; no prioritised guide, no agent API, Confluence-only.
- **Comala Read Confirmations** [35]: assign readers, one-click confirm, progress bar, re-request after edits. Exactly our `read` preset as a product.
- **Perusall** [84]: social annotation for course readings. Its scoring blends annotation quality, *opening the assignment*, *reading to the end*, active engagement time, getting responses, upvotes and quizzes, and it produces a "confusion report". This is prior art for the *requester's dashboard* (where readers struggled) and for engagement provenance.
- **Google Drive approvals** [32] and **Ziflow / Filestage** [24][25]: document-level sign-off with explicit aggregation and re-approval rules.
- No open-source project was found that combines a requester-authored prioritised item list, document anchors, configurable response types, and autosubmit with an agent API. This is a negative search result, so it is weaker than a positive one.

### 6.2 Research on document-review effectiveness

- **Fagan inspections** removed a large share of defects before testing, through defined roles and checklists [44]. The "60–90%" figure circulates in secondary sources **[unverified against the 1976 paper]**.
- **Perspective-Based Reading**: reviewers given explicit perspectives (user, tester, developer) and scenario questions found more requirements defects than with their usual technique [87]. This directly supports *different item lists per recipient* (an implementer versus a non-technical executive) over one shared checklist.
- **Review size and pace**: the SmartBear/Cisco study (2,500 reviews) recommends ≤200–400 LOC per session, ≤60–90 minutes, and slower than 500 LOC/hour [86]. This is vendor research on code, not prose, so use it only as a rough bound.
- **Modern code review** at Microsoft: the main outcome and challenge is *understanding* the change, more than finding defects [88]. Items should carry the *context* ("why I'm asking"), which the request spec has as a first-class field.
- **Acknowledgement ≠ reading** [85] (see §4.1).

### 6.3 Zero-server sharing and autosave (for the storage/delivery seams)

- **Autosave/autosubmit**: write every change to IndexedDB/localStorage immediately. Flush to the backend debounced, and on `visibilitychange → hidden` via `navigator.sendBeacon` (POST, ~64 KiB, queued reliably). MDN calls `unload`/`beforeunload` "extremely unreliable", especially on mobile [90].
- **Link-carried secrets**: Excalidraw puts an AES key in the URL fragment, which browsers never send to the server, so a dumb blob store can hold the encrypted request and responses [89]. This is a strong zero-trust default for the link-codec seam in holdall. A server-backed adapter with named accounts is the authenticated alternative.

## 7. Consolidated verdicts

| Verdict | Items |
|---|---|
| **Depend** | `@recogito/text-annotator` (BSD-3) [10]; `approx-string-match` (MIT) [7]; Driver.js (MIT, optional) [65]; `@annotorious/annotorious` (BSD-3, later, images) [12]; `@modelcontextprotocol/sdk` (MIT) for the MCP surface; Zod 4 JSON Schema export [83] |
| **Wrap / port** | Hypothesis `match-quote.ts` scoring (BSD-2, with attribution) [6]; W3C Web Annotation JSON-LD as export format [1]; MCP form-elicitation schema subset [70] |
| **Study** | Hypothesis client config and embed model [3]; Via proxy [5]; Apache Annotator selector code [14]; Reviewable dispositions and resolution rule [27]; GitHub Viewed/resolve [28][29]; Gerrit labels [30]; Drive approvals [32]; Ziflow decision calculation [26]; AppFox section approvals [36]; Comala [35]; IESG ballot positions [41]; Apache veto-with-reason [45]; Conventional Comments [46]; Kaner [47]; sociocracy consent [50]; Delphi rounds [49]; Argilla questions and `min_submitted` [79]; Label Studio [78]; gotoHuman [77]; LangGraph/A2A/OpenAI pending-state models [72][73][74]; MCP Apps [71]; Perusall analytics [84]; Marker.io/BugHerd snippet UX [19][20] |
| **Avoid** | Running the Hypothesis client as our UI (service and auth coupling) [2][9]; Annotator.js (dead) [13]; RecogitoJS (archived) [11]; Shepherd.js ≥14 and Intro.js (AGPL) [66][67]; browser-extension or bookmarklet delivery for readers; HumanLayer SDK (deprecated) [76]; JSON Forms/RJSF as dependencies (stack mismatch) [80][81]; generic agree/disagree as the only scale [52] |

## 8. Unverified or weakly sourced claims

- Pastel's exact mechanism (proxy vs iframe) for live websites.
- Confluence's built-in page-status names (from secondary sources).
- Phabricator Differential action and "Done" labels.
- HumanLayer's former SDK function names.
- Firefox support status for text fragments.
- Fagan's "60–90% of defects" figure (secondary sources).
- Applying the SmartBear code-review limits to prose review is an extrapolation.
- "No open-source equivalent exists" is a negative search result.

## REFERENCES

1. W3C. [Web Annotation Data Model](https://www.w3.org/TR/annotation-model/). W3C Recommendation, 23 Feb 2017.
2. Hypothesis. [hypothesis/client](https://github.com/hypothesis/client) (BSD-2-Clause).
3. Hypothesis. [Client configuration options](https://h.readthedocs.io/projects/client/en/latest/publishers/config.html).
4. Hypothesis. [Embedding Hypothesis in websites and platforms](https://web.hypothes.is/help/embedding-hypothesis-in-websites-and-platforms/).
5. Hypothesis. [hypothesis/via — annotation proxy](https://github.com/hypothesis/via) (BSD-2-Clause).
6. Hypothesis. [client/src/annotator/anchoring (match-quote.ts, html.ts, types.ts…)](https://github.com/hypothesis/client/tree/main/src/annotator/anchoring).
7. Knight R. [approx-string-match-js](https://github.com/robertknight/approx-string-match-js) (MIT).
8. Hypothesis. [Fuzzy Anchoring](https://web.hypothes.is/blog/fuzzy-anchoring/).
9. Hypothesis. [hypothesis/h — annotation server](https://github.com/hypothesis/h) (BSD-2-Clause).
10. Recogito. [text-annotator-js (@recogito/text-annotator)](https://github.com/recogito/text-annotator-js) (BSD-3-Clause).
11. Recogito. [recogito-js (archived)](https://github.com/recogito/recogito-js).
12. Annotorious. [annotorious/annotorious](https://github.com/annotorious/annotorious) (BSD-3-Clause).
13. Open Knowledge. [openannotation/annotator](https://github.com/openannotation/annotator) (MIT/GPL-3.0).
14. Apache. [apache/incubator-annotator (archived)](https://github.com/apache/incubator-annotator) (Apache-2.0).
15. Leeds R. [dom-anchor-text-quote](https://www.npmjs.com/package/dom-anchor-text-quote) (MIT).
16. WICG. [URL Fragment Text Directives (scroll-to-text-fragment)](https://wicg.github.io/scroll-to-text-fragment/). Draft Community Group Report.
17. Diigo. [Diigo](https://www.diigo.com/).
18. Glasp. [Glasp — social web highlighter](https://glasp.co/).
19. Marker.io. [Widget JavaScript SDK](https://help.marker.io/en/articles/4621840-widget-javascript-sdk).
20. BugHerd. [Installing BugHerd using JavaScript](https://support.bugherd.com/en/articles/33871-installing-bugherd-using-javascript).
21. Pastel. [Pastel FAQ](https://usepastel.com/faq).
22. ruttl. [ruttl — visual feedback on websites](https://ruttl.com/).
23. MarkUp.io. [MarkUp.io](https://www.markup.io/).
24. Filestage. [Submit your review decision](https://help.filestage.io/en/articles/2562896-submit-your-review-decision).
25. Ziflow. [Submit a decision or complete review in the Ziflow viewer](https://help.ziflow.com/en/articles/5806632-submit-a-decision-or-complete-review-in-the-ziflow-viewer).
26. Ziflow. [Understand decision calculation](https://help.ziflow.com/hc/en-us/articles/38343701869204).
27. Reviewable. [Discussions — dispositions and resolution](https://docs.reviewable.io/discussions).
28. GitHub. [Reviewing proposed changes in a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request).
29. GitHub. [Commenting on a pull request — resolving conversations](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request).
30. Gerrit. [Review Labels (config-labels)](https://gerrit-review.googlesource.com/Documentation/config-labels.html).
31. Google. [Use comments, action items & emoji reactions](https://support.google.com/docs/answer/65129).
32. Google. [Get approvals on files in Google Drive](https://support.google.com/drive/answer/9387535).
33. Notion. [Wikis & verified pages](https://www.notion.com/help/wikis-and-verified-pages).
34. Atlassian. [CONFCLOUD-75906: view all page statuses in one place](https://jira.atlassian.com/browse/CONFCLOUD-75906).
35. Appfire. [Comala Read Confirmations](https://marketplace.atlassian.com/apps/1222969/comala-read-confirmations).
36. AppFox. [Approvals for Confluence (Page Review & Sign-off)](https://marketplace.atlassian.com/apps/1216387/approvals-for-confluence-page-review-sign-off).
37. PowerDMS. [Assign policies to staff for acknowledgement](https://www.powerdms.com/why-powerdms/does-powerdms-let-me-assign-policies-to-staff-for-acknowledgement).
38. Phorge. [Phorge — community fork of Phabricator](https://we.phorge.it/).
39. Oxide Computer. [RFD 1: Requests for Discussion](https://rfd.shared.oxide.computer/rfd/0001).
40. Resnick P. [RFC 7282: On Consensus and Humming in the IETF](https://www.rfc-editor.org/rfc/rfc7282). 2014.
41. IESG. [IESG Ballot Procedures for Documents](https://datatracker.ietf.org/doc/statement-iesg-ballot-procedures-for-documents/).
42. Orosz G. [Companies using RFCs or design docs and examples of these](https://blog.pragmaticengineer.com/rfcs-and-design-docs/). The Pragmatic Engineer.
43. Ubl M. [Design Docs at Google](https://www.industrialempathy.com/posts/design-docs-at-google/).
44. Fagan ME. [Design and code inspections to reduce errors in program development](https://ieeexplore.ieee.org/document/5388086). IBM Systems Journal 15(3):182–211, 1976.
45. Apache Software Foundation. [Voting](https://apache.org/foundation/voting).
46. [Conventional Comments](https://conventionalcomments.org/).
47. [Gradients of agreement scale](https://en.wikipedia.org/wiki/Gradients_of_agreement_scale) (after Kaner S. et al., *Facilitator's Guide to Participatory Decision-Making*, Jossey-Bass).
48. SessionLab. [Fist to five](https://www.sessionlab.com/methods/fist-to-five).
49. Dalkey N, Helmer O. [An experimental application of the Delphi method to the use of experts](https://doi.org/10.1287/mnsc.9.3.458). Management Science 9(3):458–467, 1963.
50. Sociocracy For All. [Sociocracy summary booklet](https://www.sociocracyforall.org/wp-content/uploads/2022/06/Sociocracy-summary-booklet1.pdf).
51. [Likert scale](https://en.wikipedia.org/wiki/Likert_scale) (after Likert R., "A technique for the measurement of attitudes", Archives of Psychology 140, 1932).
52. Saris WE, Revilla M, Krosnick JA, Shaeffer EM. [Comparing questions with agree/disagree response options to questions with item-specific response options](https://ojs.ub.uni-konstanz.de/srm/article/view/2682). Survey Research Methods 4(1):61–79, 2010.
53. [MoSCoW method](https://en.wikipedia.org/wiki/MoSCoW_method).
54. Nygard M. [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions). 2011.
55. [MADR — Markdown Architectural Decision Records](https://adr.github.io/madr/).
56. Scheibehenne B, Greifeneder R, Todd PM. [Can there ever be too many options? A meta-analytic review of choice overload](https://abcwest.cogs.indiana.edu/pmwiki/pdf/scheibehenne.options.2010.pdf). J Consumer Research 37(3):409–425, 2010.
57. Chernev A, Böckenholt U, Goodman J. [Choice overload: a conceptual review and meta-analysis](https://www.kellogg.northwestern.edu/faculty/research/detail/2015/when-product-assortment-leads-to-choice-overload-a-conceptual). J Consumer Psychology 25(2), 2015.
58. Nielsen J. [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/). Nielsen Norman Group.
59. Cowan N. [The magical number 4 in short-term memory](https://doi.org/10.1017/S0140525X01003922). Behavioral and Brain Sciences 24(1):87–114, 2001.
60. Gawande A. [The Checklist Manifesto](https://atulgawande.com/book/the-checklist-manifesto/). Metropolitan Books, 2009.
61. Haynes AB et al. [A surgical safety checklist to reduce morbidity and mortality in a global population](https://doi.org/10.1056/NEJMsa0810119). NEJM 360:491–499, 2009.
62. Villar A, Callegaro M, Yang Y. [Where am I? A meta-analysis of experiments on the effects of progress indicators for web surveys](https://research.google/pubs/where-am-i-a-meta-analysis-of-experiments-on-the-effects-of-progress-indicators-for-web-surveys/). Social Science Computer Review, 2013.
63. Kivetz R, Urminsky O, Zheng Y. [The goal-gradient hypothesis resurrected](https://business.columbia.edu/sites/default/files-efs/pubfiles/1200/goalgradient.pdf). J Marketing Research 43:39–58, 2006.
64. Nunes JC, Drèze X. [The endowed progress effect: how artificial advancement increases effort](https://doi.org/10.1086/500480). J Consumer Research 32(4):504–512, 2006.
65. Ahmed K. [driver.js](https://github.com/kamranahmedse/driver.js) (MIT).
66. Shepherd. [shepherd-pro/shepherd](https://github.com/shepherd-pro/shepherd) (AGPL-3.0 / commercial).
67. usablica. [intro.js](https://github.com/usablica/intro.js) (AGPL-3.0 / commercial).
68. Barbara G. [react-joyride](https://github.com/gilbarbara/react-joyride) (MIT).
69. Model Context Protocol. [Elicitation (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation).
70. Model Context Protocol. [Elicitation (2025-11-25): form and URL modes](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).
71. Model Context Protocol. [MCP Apps — bringing UI capabilities to MCP clients](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/). 26 Jan 2026.
72. LangChain. [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).
73. A2A Project. [Agent2Agent Protocol specification — TaskState](https://a2a-protocol.org/latest/specification/).
74. OpenAI. [Agents SDK (JS): Human in the loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/).
75. Anthropic. [Claude Agent SDK: handling user input / AskUserQuestion](https://platform.claude.com/docs/en/agent-sdk/user-input).
76. HumanLayer. [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer).
77. gotoHuman. [gotohuman-mcp-server](https://github.com/gotohuman/gotohuman-mcp-server) (MIT).
78. HumanSignal. [Label Studio](https://github.com/HumanSignal/label-studio) (Apache-2.0).
79. Argilla. [Dataset management: questions, fields, distribution](https://docs.argilla.io/latest/how_to_guides/dataset/) (Apache-2.0).
80. EclipseSource. [JSON Forms](https://jsonforms.io/) (MIT).
81. rjsf-team. [react-jsonschema-form](https://github.com/rjsf-team/react-jsonschema-form) (Apache-2.0).
82. SurveyJS. [survey-library](https://github.com/surveyjs/survey-library) (MIT; Creator is commercially licensed).
83. Zod. [JSON Schema conversion (z.toJSONSchema)](https://zod.dev/json-schema).
84. Perusall. [How scoring works](https://support.perusall.com/hc/en-us/articles/38972581384727).
85. Obar JA, Oeldorf-Hirsch A. [The biggest lie on the Internet: ignoring the privacy policies and terms of service policies of social networking services](https://doi.org/10.1080/1369118X.2018.1486870). Information, Communication & Society, 2018.
86. SmartBear. [Best practices for peer code review](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/).
87. Basili VR et al. [The empirical investigation of Perspective-Based Reading](https://drum.lib.umd.edu/items/7eb0ef0c-4045-4a28-b7ca-b8e2df410d16). Empirical Software Engineering 1(2):133–164, 1996.
88. Bacchelli A, Bird C. [Expectations, outcomes, and challenges of modern code review](https://doi.org/10.1109/ICSE.2013.6606617). ICSE 2013.
89. Excalidraw. [End-to-end encryption in the browser](https://plus.excalidraw.com/blog/end-to-end-encryption). 2020.
90. MDN. [Navigator.sendBeacon()](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon).
