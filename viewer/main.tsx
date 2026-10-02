/**
 * Viewer entry: load the request, work out who is reading, restore their
 * answers, wire saving, render.
 */
import { createRoot } from 'react-dom/client';
import { Responses } from '../src/spec';
import { App } from './App';
import { loadRequest } from './load';
import type { DataProvider } from '@zodal/store';
import { defaultStore, loadLocal, makeSink, mergeResponses, saveLocal, type HttpSink, type Stored } from './persist';
import { useViewer } from './state';
import './styles.css';

export interface ViewerOptions {
  /** Where answers live on the device (seam 3); localStorage by default. */
  store?: DataProvider<Stored>;
}

/** Load the request, work out who is reading, restore their answers, wire saving, render into `root`. */
export async function mountViewer(root: HTMLElement, { store = defaultStore() }: ViewerOptions = {}) {
  let sink: HttpSink | null = null;
  try {
    const { request, origin, reader: readerParam } = await loadRequest();
    document.title = request.title;
    const v = useViewer.getState();
    sink = makeSink(request, (s) => useViewer.getState().setSink(s));
    if (sink) v.setSink({ kind: 'saving' });
    const user = sink ? (await sink.whoami())?.toLowerCase() ?? null : null;
    v.setServerUser(user);
    const match =
      request.readers.find((r) => (user && r.email?.toLowerCase() === user) || (readerParam && r.id === readerParam)) ??
      (request.readers.length === 1 && !readerParam && !user ? request.readers[0] : undefined);
    const key = match?.id ?? user ?? readerParam ?? 'me';
    const reader = { ...match, key };
    if (sink && origin !== 'spec') await sink.register(request); // throws on a conflicting registration
    // The requester opening their own request (not as a listed reader) is previewing it:
    // registering it is useful, sending answers as theirs is not.
    const preview = !!sink && !!user && !match && user === request.requester?.email?.toLowerCase();
    if (preview) {
      sink!.dispose();
      sink = null;
      v.setPreview(true);
      v.setSink({ kind: 'local' });
    }

    const id = `${request.id}:${key}`;
    const blank: Stored = {
      ...Responses.parse({ request: request.id, reader: { id: match?.id ?? readerParam, name: match?.name, email: match?.email ?? user ?? undefined }, updatedAt: new Date().toISOString() }),
      id,
    };
    let responses: Stored = mergeResponses(blank, await loadLocal(store, id));
    const remote = sink ? await sink.mine() : undefined;
    responses = mergeResponses(responses, remote);
    v.init({ request, reader, responses });
    if (sink) {
      const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
      // Anything kept here but not yet on the server (closed while offline, signed out…) goes now.
      const same = (a?: { answers: unknown; extras: unknown }, b?: { answers: unknown; extras: unknown }) =>
        !!a && !!b && canon([a.answers, a.extras]) === canon([b.answers, b.extras]);
      const has = Object.keys(responses.answers).length || responses.extras.length;
      if (has && !same(responses, remote)) {
        const { id: _drop, ...plain } = responses;
        sink.schedule(plain as Responses);
      } else v.setSink({ kind: 'sent', at: '' });
    }

    // Every change: write locally at once, schedule the sink.
    useViewer.subscribe((s, prev) => {
      if (!s.responses || s.responses === prev.responses) return;
      const value = { ...(s.responses as Responses), id } as Stored;
      void saveLocal(store, value).then((ok) => useViewer.getState().setLocalSaved(ok));
      const { id: _drop, ...plain } = value;
      sink?.schedule(plain as Responses);
    });
  } catch (e) {
    useViewer.getState().fail((e as Error).message);
  }
  createRoot(root).render(<App sink={sink} />);
}

// Following a link to another request from this page only changes the fragment, and the
// browser does not reload for that. A different request is a different page: reload.
const requestInHash = () => new URLSearchParams(location.hash.slice(1)).get('r');
let shownHash = requestInHash();
addEventListener('hashchange', () => {
  const now = requestInHash();
  if (now && now !== shownHash) location.reload();
  shownHash = now;
});

void mountViewer(document.getElementById('root')!);
