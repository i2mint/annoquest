/**
 * The guide: the document on one side, the panel that walks the reader through
 * the request on the other. One primary action (Next), the current tier open,
 * later tiers folded with their counts, the save state always visible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commentRequired, resolveResponseType } from '../src/presets';
import { replyLink } from '../src/link';
import type { Doc, Item, Option, Request, ResponseType, Target } from '../src/spec';
import { DocFrame, textFragmentUrl, type Anchored } from './docframe';
import type { HttpSink } from './persist';
import { answered, modeOf, queue, tiers, useViewer, type ViewerState } from './state';

const TIER_LABEL = { must: 'Most important', should: 'Important', could: 'If you have time' } as const;
const TONE_CLASS: Record<Option['tone'], string> = { positive: 'tone-pos', neutral: 'tone-neu', attention: 'tone-att', blocking: 'tone-blk' };

// ---------------------------------------------------------------------------

export function App({ sink }: { sink: HttpSink | null }) {
  const request = useViewer((s) => s.request);
  const error = useViewer((s) => s.error);
  if (error) return <Notice title="This request could not be opened" body={error} />;
  if (!request) return <Notice title="Loading…" body="" busy />;
  return <Guide request={request} sink={sink} />;
}

function Notice({ title, body, busy }: { title: string; body: string; busy?: boolean }) {
  return (
    <main className="notice" aria-busy={busy}>
      <h1>{title}</h1>
      {body && <p>{body}</p>}
    </main>
  );
}

// ---------------------------------------------------------------------------

function Guide({ request, sink }: { request: Request; sink: HttpSink | null }) {
  const reader = useViewer((s) => s.reader);
  const responses = useViewer((s) => s.responses);
  const view = useViewer((s) => s.view);
  const current = useViewer((s) => s.current);
  const { go, setView, setSeen } = useViewer.getState();
  const items = useMemo(() => queue(request, reader.id), [request, reader.id]);
  const mode = modeOf(request, reader);
  const frames = useRef(new Map<string, DocFrame | null>());
  const [, bump] = useState(0);
  const [selection, setSelection] = useState<{ doc: string; target: Target; text: string } | null>(null);

  const currentItem = items.find((i) => i.id === current) ?? null;
  const docOfItem = (i: Item | null): Doc => request.documents.find((d) => d.id === i?.doc) ?? request.documents[0]!;
  const [shownDoc, setShownDoc] = useState(request.documents[0]!.id);
  useEffect(() => {
    if (currentItem) setShownDoc(docOfItem(currentItem).id);
  }, [currentItem?.id]);

  const anchorOf = useCallback(
    (i: Item): Anchored | null => {
      const f = frames.current.get(docOfItem(i).id);
      return f ? f.anchor(i) : null;
    },
    [request],
  );

  // Paint and reveal whenever the current item, answers, or a frame change.
  const extras = responses?.extras ?? [];
  useEffect(() => {
    for (const [docId, f] of frames.current) {
      if (!f) continue;
      const mine = items.filter((i) => docOfItem(i).id === docId);
      const done = new Set(mine.filter((i) => answered(responses, i.id)).map((i) => i.id));
      f.paint(mine, { current: current ?? undefined, done, extras: extras.filter((x) => x.doc === docId).map((x) => x.target) });
    }
    if (currentItem) {
      const f = frames.current.get(docOfItem(currentItem).id);
      if (f) {
        const a = f.anchor(currentItem);
        setSeen(currentItem.id, a.passageHash);
        f.reveal(currentItem);
      }
    }
  }, [current, responses, frames.current.size, bump]);

  const onFrame = useCallback(
    (docId: string, frame: DocFrame | null) => {
      frames.current.set(docId, frame);
      bump((n) => n + 1);
      if (!frame) return;
      frame.doc.addEventListener('click', (e) => {
        const hit = frame.itemAt(items.filter((i) => docOfItem(i).id === docId), e.clientX, e.clientY);
        if (hit) go(hit);
      });
      frame.doc.addEventListener('selectionchange', () => {
        const s = frame.selection();
        setSelection(s ? { doc: docId, ...s } : null);
      });
    },
    [items],
  );

  const next = () => {
    const at = currentItem ? items.indexOf(currentItem) : -1;
    const after = items.slice(at + 1).find((i) => !answered(responses, i.id)) ?? items.slice(0, Math.max(0, at)).find((i) => !answered(responses, i.id));
    if (!after) return setView('done');
    if (currentItem && after.priority !== currentItem.priority && items.filter((i) => i.priority === currentItem.priority).every((i) => answered(responses, i.id))) {
      go(after.id);
      return setView('pause');
    }
    go(after.id);
  };
  const back = () => {
    const at = currentItem ? items.indexOf(currentItem) : items.length;
    if (at > 0) go(items[at - 1]!.id);
  };
  const start = () => go((items.find((i) => !answered(responses, i.id)) ?? items[0]!).id);

  useEffect(() => {
    if (view === 'item' && !current) start();
  }, [view, current]);

  return (
    <div className="layout">
      <section className="doc-pane" aria-label="Document">
        {request.documents.length > 1 && (
          <div className="doc-tabs" role="tablist">
            {request.documents.map((d) => (
              <button key={d.id} role="tab" aria-selected={shownDoc === d.id} onClick={() => setShownDoc(d.id)}>
                {d.title ?? d.id}
              </button>
            ))}
          </div>
        )}
        {request.documents.map((d) => (
          <DocView key={d.id} doc={d} hidden={d.id !== shownDoc} onFrame={onFrame} />
        ))}
      </section>
      <aside className="panel" aria-label="Guide">
        <Header request={request} sink={sink} />
        <Progress items={items} />
        <div className="panel-body">
          {view === 'intro' && <Intro request={request} items={items} onStart={start} />}
          {view === 'pause' && currentItem && <Pause next={currentItem} onGo={() => setView('item')} onStop={() => setView('done')} />}
          {view === 'item' && currentItem && (
            <ItemCard
              key={currentItem.id}
              request={request}
              item={currentItem}
              anchored={anchorOf(currentItem)}
              doc={docOfItem(currentItem)}
              index={items.indexOf(currentItem)}
              total={items.length}
              onNext={next}
              onBack={back}
            />
          )}
          {view === 'done' && <Done request={request} items={items} sink={sink} />}
          {request.allowExtra && selection && view !== 'intro' && <SelectionBox selection={selection} onDone={() => setSelection(null)} />}
          {view !== 'intro' && <ItemList items={items} request={request} mode={mode} />}
          {view !== 'intro' && view !== 'done' && (
            <button className="link-btn finish" onClick={() => setView('done')}>
              Finish for now
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DocView({ doc, hidden, onFrame }: { doc: Doc; hidden: boolean; onFrame: (id: string, f: DocFrame | null) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [detached, setDetached] = useState(false);
  const onLoad = () => {
    try {
      onFrame(doc.id, new DocFrame(ref.current!));
      setDetached(false);
    } catch {
      onFrame(doc.id, null);
      setDetached(true);
    }
  };
  const src = doc.source.kind === 'url' ? doc.source.url : undefined;
  const srcDoc = doc.source.kind === 'inline' ? withBase(doc.source.html, doc.source.baseUrl) : undefined;
  return (
    <div className="doc-view" hidden={hidden}>
      {detached && (
        <p className="doc-detached">
          This document is on another site, so passages can't be highlighted here. Each item shows its passage, with a link to it in the original.
        </p>
      )}
      <iframe ref={ref} title={doc.title ?? doc.id} src={src} srcDoc={srcDoc} onLoad={onLoad} sandbox="allow-same-origin allow-popups" />
    </div>
  );
}

const withBase = (html: string, baseUrl?: string) =>
  baseUrl && !/<base\s/i.test(html) ? html.replace(/<head([^>]*)>/i, (m) => `${m}<base href="${baseUrl.replace(/"/g, '&quot;')}" target="_blank">`) : html;

// ---------------------------------------------------------------------------

function Header({ request, sink }: { request: Request; sink: HttpSink | null }) {
  const s = useViewer((x) => x.sink);
  const localSaved = useViewer((x) => x.localSaved);
  const user = useViewer((x) => x.serverUser);
  const reader = useViewer((x) => x.reader);
  let status: { text: string; cls: string; action?: { label: string; run: () => void } };
  if (s.kind === 'local') status = localSaved ? { text: 'Saved on this device', cls: 'ok' } : { text: "Couldn't save on this device — use “Download” when done", cls: 'bad' };
  else if (s.kind === 'saving') status = { text: 'Saving…', cls: 'busy' };
  else if (s.kind === 'pending') status = { text: 'Saved on this device · sending shortly', cls: 'busy' };
  else if (s.kind === 'waiting') status = { text: "Saved on this device · will send once the sender has opened this request", cls: 'warn' };
  else if (s.kind === 'sent') status = { text: s.at ? `Saved · sent ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Up to date', cls: 'ok' };
  else if (s.kind === 'offline') status = { text: 'Saved on this device · will send when back online', cls: 'warn', action: { label: 'Retry', run: () => void sink?.flush() } };
  else if (s.kind === 'auth') status = { text: 'Saved on this device · sign in again to send', cls: 'warn', action: { label: 'Sign in', run: () => location.reload() } };
  else status = { text: s.message, cls: 'bad' };
  const preview = useViewer((x) => x.preview);
  if (preview) status = { text: 'Preview: you sent this request, so nothing you click here is sent', cls: 'busy' };
  const who = reader.name ?? user ?? reader.email;
  return (
    <header className="panel-head">
      <h1>{request.title}</h1>
      <p className="meta">
        {request.requester?.name && <>From {request.requester.name}</>}
        {who && <> · answering as {who}</>}
        {request.due && <> · by {request.due}</>}
      </p>
      <p className={`save save-${status.cls}`} role="status" aria-live="polite">
        {status.text}
        {status.action && (
          <button className="link-btn" onClick={status.action.run}>
            {status.action.label}
          </button>
        )}
      </p>
    </header>
  );
}

function Progress({ items }: { items: Item[] }) {
  const responses = useViewer((s) => s.responses);
  const ts = tiers(items, responses);
  return (
    <div className="progress" aria-label="Progress">
      {ts.map((t) => (
        <div key={t.priority} className={`tier-progress p-${t.priority}`}>
          <span>{TIER_LABEL[t.priority]}</span>
          <meter min={0} max={t.items.length} value={t.done} />
          <span className="count">
            {t.done}/{t.items.length}
          </span>
        </div>
      ))}
    </div>
  );
}

function Intro({ request, items, onStart }: { request: Request; items: Item[]; onStart: () => void }) {
  const responses = useViewer((s) => s.responses);
  const reader = useViewer((s) => s.reader);
  const user = useViewer((s) => s.serverUser);
  const { setName } = useViewer.getState();
  const ts = tiers(items, responses);
  const needName = !reader.name && !user && !reader.id;
  return (
    <div className="intro">
      {(request.intro ?? '').split(/\n\s*\n/).filter(Boolean).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <ul className="tier-summary">
        {ts.map((t) => (
          <li key={t.priority}>
            <strong>{TIER_LABEL[t.priority]}</strong>: {t.items.length} item{t.items.length > 1 ? 's' : ''}
            {t.minutes ? ` · about ${Math.round(t.minutes)} min` : ''}
          </li>
        ))}
      </ul>
      <p className="hint">Start with the most important ones; you can stop at any point. Every answer is saved as you give it{request.sink.kind === 'http' ? ' and sent automatically' : ''}.</p>
      {needName && (
        <label className="field">
          Your name (so your answers can be told apart)
          <input defaultValue={responses?.reader.name ?? ''} onBlur={(e) => setName(e.target.value.trim())} placeholder="Optional" />
        </label>
      )}
      <button className="primary" onClick={onStart}>
        {Object.keys(responses?.answers ?? {}).length ? 'Continue' : 'Start'}
      </button>
    </div>
  );
}

function Pause({ next, onGo, onStop }: { next: Item; onGo: () => void; onStop: () => void }) {
  return (
    <div className="pause">
      <h2>That tier is done. Thank you.</h2>
      <p>
        Next up: <strong>{TIER_LABEL[next.priority].toLowerCase()}</strong> items. Keep going, or stop here; your answers are saved.
      </p>
      <div className="row">
        <button className="primary" onClick={onGo}>
          Keep going
        </button>
        <button onClick={onStop}>Stop here</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ItemCard(p: { request: Request; item: Item; anchored: Anchored | null; doc: Doc; index: number; total: number; onNext: () => void; onBack: () => void }) {
  const { request, item, anchored, doc } = p;
  const a = useViewer((s) => s.responses?.answers[item.id]);
  const { answer } = useViewer.getState();
  const rt = resolveResponseType(item, request);
  const chosen = ([] as string[]).concat(a?.value === true ? [rt.options[0]?.value ?? 'read'] : (a?.value ?? []));
  const chosenOpts = rt.options.filter((o) => chosen.includes(o.value));
  const needComment = item.comment === 'required' || chosenOpts.some(commentRequired);
  const encouraged = chosenOpts.some((o) => o.comment === 'encouraged');
  const passage = anchored?.passage ?? item.target?.quote?.exact;
  const href = doc.href ?? (doc.source.kind === 'url' ? doc.source.url : undefined);
  const stale = !!(a?.passageHash && anchored?.passageHash && a.passageHash !== anchored.passageHash);

  const pick = (o: Option) => {
    if (rt.kind === 'ack') return answer(item.id, { value: a?.value === true ? undefined : true });
    if (rt.kind === 'multi') {
      const set = new Set(chosen);
      set.has(o.value) ? set.delete(o.value) : set.add(o.value);
      return answer(item.id, { value: set.size ? [...set] : undefined });
    }
    answer(item.id, { value: a?.value === o.value ? undefined : o.value });
  };

  return (
    <article className={`card p-${item.priority}`} aria-labelledby={`t-${item.id}`}>
      <p className="where">
        <span className={`badge p-${item.priority}`}>{TIER_LABEL[item.priority]}</span>
        <span className="pos">
          {p.index + 1} of {p.total}
        </span>
        {anchored?.sectionLabel && <span className="sec">§ {anchored.sectionLabel}</span>}
        {item.minutes && <span className="mins">~{item.minutes} min</span>}
      </p>
      {item.title && <h2 id={`t-${item.id}`}>{item.title}</h2>}
      {passage && (
        <blockquote className={anchored?.how === 'section' ? 'section-excerpt' : ''}>
          {anchored?.how === 'section' ? passage.slice(0, 280) + (passage.length > 280 ? '…' : '') : passage}
        </blockquote>
      )}
      {anchored?.how === 'missing' && <p className="warn-text">This passage is no longer in the document as written; it may have been edited. The text above is what was asked about.</p>}
      {anchored === null && href && item.target?.quote && (
        <p>
          <a href={textFragmentUrl(href, item.target.quote)} target="_blank" rel="noreferrer">
            Open this passage in the original ↗
          </a>
        </p>
      )}
      <p className="prompt" id={item.title ? undefined : `t-${item.id}`}>
        {item.prompt}
      </p>
      {stale && <p className="warn-text">The passage changed after you answered; please check your answer still holds.</p>}
      <Controls rt={rt} chosen={chosen} onPick={pick} />
      {item.comment !== 'none' && (
        <label className="field">
          {rt.kind === 'text' ? 'Your comment' : needComment ? 'Comment (please say why)' : 'Comment (optional)'}
          <textarea
            value={a?.comment ?? ''}
            onChange={(e) => answer(item.id, { comment: e.target.value })}
            rows={needComment || encouraged || rt.kind === 'text' ? 4 : 2}
            placeholder={needComment ? 'A sentence is enough' : encouraged ? 'Optional, but it helps' : ''}
          />
          {needComment && !a?.comment?.trim() && <span className="hint">A short reason helps the requester act on this.</span>}
        </label>
      )}
      <div className="row nav">
        <button onClick={p.onBack} disabled={p.index === 0}>
          Back
        </button>
        <button className="primary" onClick={p.onNext}>
          {answered(useViewer.getState().responses, item.id) ? 'Next' : 'Skip for now'}
        </button>
      </div>
    </article>
  );
}

function Controls({ rt, chosen, onPick }: { rt: ResponseType; chosen: string[]; onPick: (o: Option) => void }) {
  if (rt.kind === 'text') return null;
  if (rt.kind === 'ack') {
    const o = rt.options[0] ?? { value: 'read', label: "I've read this", tone: 'positive' as const };
    const on = chosen.length > 0;
    return (
      <button className={`ack ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onPick(o)}>
        <span className="box" aria-hidden>
          {on ? '✓' : ''}
        </span>
        {o.label}
      </button>
    );
  }
  return (
    <div className="options" role={rt.kind === 'choice' ? 'radiogroup' : 'group'} aria-label={rt.label ?? 'Answer'}>
      {rt.options.map((o) => {
        const on = chosen.includes(o.value);
        return (
          <button key={o.value} role={rt.kind === 'choice' ? 'radio' : 'checkbox'} aria-checked={on} className={`opt ${TONE_CLASS[o.tone]} ${on ? 'on' : ''}`} onClick={() => onPick(o)} title={o.hint}>
            <span className="dot" aria-hidden />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ItemList({ items, request, mode }: { items: Item[]; request: Request; mode: 'guided' | 'checklist' }) {
  const responses = useViewer((s) => s.responses);
  const current = useViewer((s) => s.current);
  const { go } = useViewer.getState();
  const ts = tiers(items, responses);
  const currentTier = items.find((i) => i.id === current)?.priority ?? ts[0]?.priority;
  return (
    <nav className="item-list" aria-label="All items">
      {ts.map((t) => (
        <details key={t.priority} open={mode === 'checklist' || t.priority === currentTier}>
          <summary>
            {TIER_LABEL[t.priority]} <span className="count">{t.items.length - t.done ? `${t.items.length - t.done} to go` : 'all done'}</span>
          </summary>
          <ol>
            {t.items.map((i) => {
              const tone = toneOf(i, request, responses);
              return (
                <li key={i.id}>
                  <button className={`row-btn ${i.id === current ? 'cur' : ''}`} onClick={() => go(i.id)} aria-current={i.id === current ? 'step' : undefined}>
                    <span className={`state ${tone ? TONE_CLASS[tone] : ''} ${answered(responses, i.id) ? 'done' : ''}`} aria-label={answered(responses, i.id) ? 'answered' : 'not answered'} />
                    <span className="label">{i.title ?? i.prompt}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </details>
      ))}
    </nav>
  );
}

function toneOf(i: Item, request: Request, r: ViewerState['responses']): Option['tone'] | undefined {
  const a = r?.answers[i.id];
  if (!a || a.value === undefined) return a?.comment ? 'neutral' : undefined;
  const rt = resolveResponseType(i, request);
  if (a.value === true) return 'positive';
  const vals = ([] as string[]).concat(a.value);
  const tones = rt.options.filter((o) => vals.includes(o.value)).map((o) => o.tone);
  return (['blocking', 'attention', 'positive', 'neutral'] as const).find((t) => tones.includes(t));
}

// ---------------------------------------------------------------------------

function SelectionBox({ selection, onDone }: { selection: { doc: string; target: Target; text: string }; onDone: () => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const { addExtra } = useViewer.getState();
  if (!open)
    return (
      <div className="selection">
        <p>
          Selected: “{selection.text.slice(0, 80)}
          {selection.text.length > 80 ? '…' : ''}”
        </p>
        <button onClick={() => setOpen(true)}>Comment on this</button>
      </div>
    );
  return (
    <div className="selection">
      <p>“{selection.text.slice(0, 160)}”</p>
      <label className="field">
        Your comment
        <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="row">
        <button
          className="primary"
          disabled={!text.trim()}
          onClick={() => {
            addExtra({ doc: selection.doc, target: selection.target, comment: text.trim() });
            onDone();
          }}
        >
          Save comment
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Done({ request, items, sink }: { request: Request; items: Item[]; sink: HttpSink | null }) {
  const responses = useViewer((s) => s.responses);
  const s = useViewer((x) => x.sink);
  const { finish, removeExtra } = useViewer.getState();
  const [copied, setCopied] = useState(false);
  const n = items.filter((i) => answered(responses, i.id)).length;
  const left = items.length - n;
  useEffect(() => {
    if (!responses?.finishedAt) finish();
    void sink?.flush();
  }, []);
  const link = responses ? replyLink(responses, location.href) : null;
  const download = () => {
    const blob = new Blob([JSON.stringify(responses, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${request.title.replace(/[^\w-]+/g, '-').slice(0, 40)}-answers.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="done">
      <h2>{left ? `${n} of ${items.length} answered` : 'All done. Thank you.'}</h2>
      {left > 0 && <p>You can come back to the {left} remaining item{left > 1 ? 's' : ''} any time from this page; your answers are kept.</p>}
      {request.sink.kind === 'http' ? (
        <p>{s.kind === 'sent' ? 'Your answers have been sent. Nothing else to do.' : 'Your answers are saved here and will be sent as soon as possible.'}</p>
      ) : (
        <>
          <p>Your answers are saved in this browser. To send them back, share this reply link with {request.requester?.name ?? 'the requester'}:</p>
          <div className="row">
            <button
              className="primary"
              onClick={async () => {
                if (link) await navigator.clipboard.writeText(link.url).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? 'Copied ✓' : 'Copy reply link'}
            </button>
            {request.requester?.email && link && link.tier === 'email' && (
              <a className="btn" href={`mailto:${request.requester.email}?subject=${encodeURIComponent('Re: ' + request.title)}&body=${encodeURIComponent(link.url)}`}>
                Email it
              </a>
            )}
            <button onClick={download}>Download</button>
          </div>
        </>
      )}
      {!!responses?.extras.length && (
        <>
          <h3>Your other comments</h3>
          <ul className="extras">
            {responses.extras.map((x) => (
              <li key={x.id}>
                “{x.target.quote?.exact.slice(0, 80)}”: {x.comment}{' '}
                <button className="link-btn" onClick={() => removeExtra(x.id)}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
