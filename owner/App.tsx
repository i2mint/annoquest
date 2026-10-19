/**
 * The owner page's views. Data comes from the owner API; every stat and export is the
 * library's fold over the request's events (`exportLog`), the same one the CLI runs.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { contentLink } from '../src/content';
import { exportLog, exportMarkdown, type Export, type ReaderLog } from '../src/events';
import type { Request } from '../src/spec';
import { api, type RequestSummary } from './api';
import { navigate, parseRoute, useHash } from './route';

type Loaded<T> = { key: string; data?: T; error?: string };

/** Load `fn()` for `key`; the status belongs to the key, so a new key shows loading at once. */
function useLoad<T>(key: string, fn: () => Promise<T>): { data?: T; error?: string; loading: boolean; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ key: '' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => live && setState({ key, data }),
      (e: Error) => live && setState({ key, error: e.message }),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const mine = state.key === key;
  return { data: mine ? state.data : undefined, error: mine ? state.error : undefined, loading: !mine, reload: () => setTick((t) => t + 1) };
}

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const who = (r: ReaderLog) => (r.person?.name ? `${r.person.name}` : r.reader);
const pageName = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.hash}` || u.host;
  } catch {
    return url;
  }
};

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 1800);
    return () => clearTimeout(t);
  }, [done]);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setDone('copied'),
      () => setDone('failed'),
    );
  return (
    <button type="button" onClick={copy} aria-live="polite">
      {done === 'copied' ? 'Copied ✓' : done === 'failed' ? 'Select and copy' : label}
    </button>
  );
}

function LinkBox({ link }: { link: string }) {
  return (
    <div className="linkbox">
      <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Link" />
      <Copy text={link} />
      <a className="btn" href={link} target="_blank" rel="noopener">
        Open
      </a>
    </div>
  );
}

function Status({ loading, error, reload, children }: { loading: boolean; error?: string; reload: () => void; children: ReactNode }) {
  if (error)
    return (
      <p className="error" role="alert">
        {error} <button onClick={reload}>Try again</button>
      </p>
    );
  if (loading)
    return (
      <div className="skeleton" aria-busy="true" aria-label="Loading">
        <div />
        <div />
        <div />
      </div>
    );
  return <>{children}</>;
}

export function App() {
  const route = parseRoute(useHash());
  useEffect(() => {
    document.title = route.view === 'requests' ? 'annoquest · requests' : `annoquest · ${route.view === 'reader' ? route.reader : route.id}`;
  }, [route.view, (route as { id?: string }).id, (route as { reader?: string }).reader]);
  return (
    <main>
      <header className="top">
        <a href="#/" onClick={(e) => (e.preventDefault(), navigate({ view: 'requests' }))} className="home">
          annoquest
        </a>
        <span className="muted">owner</span>
      </header>
      {route.view === 'requests' && <Requests />}
      {route.view !== 'requests' && <RequestView id={route.id} reader={route.view === 'reader' ? route.reader : undefined} />}
    </main>
  );
}

function Requests() {
  const list = useLoad('requests', api.requests);
  return (
    <>
      <MakeLink />
      <section>
        <h1>Requests</h1>
        <Status {...list}>
          {list.data?.length === 0 && <p className="muted">No requests yet. Make a link above and open it once.</p>}
          <ul className="cards">
            {list.data?.map((r) => <RequestCard key={r.id} r={r} />)}
          </ul>
        </Status>
      </section>
    </>
  );
}

function RequestCard({ r }: { r: RequestSummary }) {
  return (
    <li>
      <a className="card" href={`#/r/${encodeURIComponent(r.id)}`} onClick={(e) => (e.preventDefault(), navigate({ view: 'request', id: r.id }))}>
        <strong>{r.title || r.id}</strong>
        <span className="muted small">{r.kind === 'content' ? `Freeform · ${r.content}` : `Guided · ${plural(r.items, 'item')}`}</span>
        <span className="small">
          {plural(r.readers, 'reader')} · {plural(r.events, 'event')} · last {when(r.lastAt)}
        </span>
      </a>
    </li>
  );
}

function MakeLink() {
  const [url, setUrl] = useState('');
  const [reader, setReader] = useState('');
  const [state, setState] = useState<{ link?: string; error?: string; busy?: boolean }>({});
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ busy: true });
    try {
      setState({ link: await api.link(url.trim(), reader.trim()) });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };
  return (
    <section className="panel">
      <h2>Make a link</h2>
      <form onSubmit={submit} className="form">
        <label>
          Page to annotate
          <input type="url" required placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Reader <span className="muted">(optional; else each browser gets its own id)</span>
          <input value={reader} onChange={(e) => setReader(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
        <button className="primary" disabled={state.busy || !url.trim()}>
          {state.busy ? 'Making…' : 'Make link'}
        </button>
      </form>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.link && <LinkBox link={state.link} />}
    </section>
  );
}

interface RequestData {
  request: Request;
  log: Export;
  rejected: number;
  viewer?: string | null;
}

async function loadRequest(id: string): Promise<RequestData> {
  const [request, { batches, rejected }, { viewer }] = await Promise.all([api.request(id), api.events(id), api.config()]);
  return { request, log: exportLog(batches, { request }), rejected: rejected.length, viewer };
}

function RequestView({ id, reader }: { id: string; reader?: string }) {
  const got = useLoad(`request:${id}`, () => loadRequest(id));
  const r = reader === undefined ? undefined : got.data?.log.readers.find((x) => x.reader === reader);
  return (
    <Status {...got}>
      {got.data && reader === undefined && <RequestPage d={got.data} reload={got.reload} />}
      {got.data && reader !== undefined && (r ? <ReaderPage d={got.data} r={r} /> : <p className="error">No reader {reader} in this request.</p>)}
    </Status>
  );
}

function RequestPage({ d, reload }: { d: RequestData; reload: () => void }) {
  const { request, log } = d;
  const c = request.content;
  const base = `annoquest-${request.id}`;
  const readers = [...log.readers].sort((a, b) => (b.analytics.lastAt ?? '').localeCompare(a.analytics.lastAt ?? ''));
  return (
    <>
      <section>
        <h1>{request.title ?? request.id}</h1>
        <p className="muted small">
          {c ? `Freeform on ${c.url}` : `Guided · ${plural(request.items.length, 'item')}`} · {request.id}
        </p>
        {c && d.viewer && <LinkBox link={contentLink(d.viewer, c.url, c.token)} />}
        {c && d.viewer && <p className="muted small">Add &amp;reader=&lt;name&gt; to name the reader.</p>}
        <div className="actions">
          <button onClick={() => download(`${base}.md`, exportMarkdown(log, { request }), 'text/markdown')}>Download Markdown</button>
          <button onClick={() => download(`${base}.json`, JSON.stringify(log, null, 2), 'application/json')}>Download JSON</button>
          <Copy text={exportMarkdown(log, { request })} label="Copy Markdown" />
          <button onClick={reload}>Refresh</button>
        </div>
        {d.rejected > 0 && <p className="muted small">{plural(d.rejected, 'stored batch', 'stored batches')} could not be read and are left out.</p>}
      </section>
      <section>
        <h2>{plural(log.readers.length, 'reader')}</h2>
        {log.readers.length === 0 && <p className="muted">Nobody has opened it yet.</p>}
        <ul className="cards">
          {readers.map((r) => (
            <li key={r.reader}>
              <a className="card" href={`#/r/${encodeURIComponent(request.id)}/${encodeURIComponent(r.reader)}`} onClick={(e) => (e.preventDefault(), navigate({ view: 'reader', id: request.id, reader: r.reader }))}>
                <strong>{who(r)}</strong>
                {r.person?.name && <span className="muted small">{r.reader}</span>}
                <span className="small">
                  {plural(r.responses.extras.length, 'comment')} · {plural(Object.keys(r.responses.answers).length, 'answer')} · {dur(r.analytics.dwellMs)} on screen ({dur(r.analytics.activeMs)} active) · {plural(r.analytics.pages.length, 'page')}
                </span>
                <span className="muted small">
                  {when(r.analytics.firstAt)} – {when(r.analytics.lastAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function ReaderPage({ d, r }: { d: RequestData; r: ReaderLog }) {
  const { request } = d;
  const a = r.analytics;
  const one: Export = { ...d.log, readers: [r] };
  const answers = Object.entries(r.responses.answers);
  return (
    <>
      <section>
        <p className="small">
          <a href={`#/r/${encodeURIComponent(request.id)}`} onClick={(e) => (e.preventDefault(), navigate({ view: 'request', id: request.id }))}>
            ← {request.title ?? request.id}
          </a>
        </p>
        <h1>{who(r)}</h1>
        <p className="muted small">
          {r.reader} · {plural(a.sessions.length, 'session')} · {plural(r.devices.length, 'device')} · {when(a.firstAt)} – {when(a.lastAt)}
        </p>
        <p>
          {dur(a.dwellMs)} on screen, {dur(a.activeMs)} active.
        </p>
        <div className="actions">
          <button onClick={() => download(`annoquest-${request.id}-${r.reader}.md`, exportMarkdown(one, { request }), 'text/markdown')}>Download Markdown</button>
          <Copy text={exportMarkdown(one, { request })} label="Copy Markdown" />
        </div>
      </section>
      <section>
        <h2>{plural(r.responses.extras.length, 'comment')}</h2>
        <ul className="comments">
          {r.responses.extras.map((e) => (
            <li key={e.id}>
              {e.target.quote && (
                <blockquote>
                  “{e.target.quote.exact}”{(e.target.quote.occurrence ?? 1) > 1 && <span className="muted small"> (match {e.target.quote.occurrence})</span>}
                </blockquote>
              )}
              <p>{e.comment || <span className="muted">(no comment)</span>}</p>
              <p className="muted small">
                {pageName(e.url ?? e.doc)} · {when(e.at)}
                {(e.rev ?? 0) > 0 && ` · edited ${plural(e.rev ?? 0, 'time')}`}
              </p>
            </li>
          ))}
        </ul>
      </section>
      {answers.length > 0 && (
        <section>
          <h2>{plural(answers.length, 'answer')}</h2>
          <ul className="comments">
            {answers.map(([item, ans]) => {
              const it = request.items.find((i) => i.id === item);
              const value = ans.value === undefined ? '' : ans.value === true ? '✓' : ([] as string[]).concat(ans.value).join(', ');
              return (
                <li key={item}>
                  <strong>{it?.title ?? item}</strong> {value}
                  {ans.comment && <p>{ans.comment}</p>}
                  <p className="muted small">{when(ans.at)}</p>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section>
        <h2>{plural(a.pages.length, 'page')}</h2>
        <table className="pages">
          <thead>
            <tr>
              <th>page</th>
              <th>views</th>
              <th>on screen</th>
              <th>active</th>
              <th>furthest scroll</th>
            </tr>
          </thead>
          <tbody>
            {a.pages.map((p) => (
              <tr key={p.url}>
                <td data-label="page">
                  {p.title && <span>{p.title}</span>}
                  <span className="muted small"> {pageName(p.url)}</span>
                </td>
                <td data-label="views">{p.views}</td>
                <td data-label="on screen">{dur(p.dwellMs)}</td>
                <td data-label="active">{dur(p.activeMs)}</td>
                <td data-label="furthest scroll">{p.depth === undefined ? '—' : `${Math.round(p.depth * 100)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
