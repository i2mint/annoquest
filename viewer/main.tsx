/**
 * Viewer entry: load the request, work out who is reading, restore their
 * answers, wire saving, render.
 */
import { createRoot } from 'react-dom/client';
import { parseRequest } from '../src/request';
import { Responses } from '../src/spec';
import { diffResponses } from '../src/events';
import { App } from './App';
import { deviceId, deviceReader } from './device';
import { loadRequest } from './load';
import type { DataProvider } from '@zodal/store';
import { defaultStore, loadLocal, makeSink, mergeResponses, saveLocal, type HttpSink, type Stored } from './persist';
import { useViewer } from './state';
import { createTracker, type Tracker } from './track';
import './styles.css';

export interface ViewerOptions {
  /** Where answers live on the device (seam 3); localStorage by default. */
  store?: DataProvider<Stored>;
}

/** Load the request, work out who is reading, restore their answers, wire saving, render into `root`. */
export async function mountViewer(root: HTMLElement, { store = defaultStore() }: ViewerOptions = {}) {
  let sink: HttpSink | null = null;
  let tracker: Tracker | null = null;
  try {
    const loaded = await loadRequest();
    let request = loaded.request;
    const { origin, reader: readerParam } = loaded;
    const v = useViewer.getState();
    const device = deviceId();
    sink = makeSink(request, (s) => useViewer.getState().setSink(s), { device });
    if (sink) v.setSink({ kind: 'saving' });
    const user = sink ? (await sink.whoami())?.toLowerCase() ?? null : null;
    v.setServerUser(user);
    const isSender = !!user && user === request.requester?.email?.toLowerCase();
    if (sink && origin !== 'spec') {
      const reg = await sink.register(request);
      if (reg.status === 409) {
        // The server holds a different version under this id. From its sender, this link is
        // a new revision to preview and publish; from anyone else, it is not the request.
        if (isSender) v.setPublishable(true);
        else throw new Error('This link does not match the request registered under its id, so answers cannot be sent. Ask its sender for a fresh link.');
      } else {
        // The id is one request with revisions: always show the latest one.
        const latest = await sink.latest();
        if (latest) request = parseRequest(latest);
      }
    }
    document.title = request.title;
    // With a sink and nobody signed in, an unnamed reader is this browser (its device id), so two
    // people opening one link stay apart; without a sink, a lone listed reader is assumed.
    const match =
      request.readers.find((r) => (user && r.email?.toLowerCase() === user) || (readerParam && r.id === readerParam)) ??
      (request.readers.length === 1 && !readerParam && !user && !sink ? request.readers[0] : undefined);
    const key = match?.id ?? user ?? readerParam ?? (sink ? deviceReader(device) : 'me');
    // A reader named by the link is named: no need to ask for a name.
    const reader = { ...match, id: match?.id ?? readerParam, key };
    // The requester opening their own request (not as a listed reader) is previewing it:
    // registering it is useful, sending answers as theirs is not.
    // A version the server does not hold is always a preview for its sender, even one listed as a
    // reader: answers must never be sent against an unpublished version.
    const preview = !!sink && isSender && (!match || useViewer.getState().publishable);
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
    sink?.identify({ reader: key, person: { id: match?.id ?? readerParam, name: match?.name, email: match?.email ?? user ?? undefined } });
    const remote = sink ? await sink.mine() : undefined;
    responses = mergeResponses(responses, remote);
    v.init({ request, reader, responses });
    if (sink) {
      // Anything kept here but not yet on the server (closed while offline, signed out…) goes now.
      const missing = diffResponses(remote ?? null, responses);
      if (missing.length) sink.push(missing);
      else v.setSink({ kind: 'sent', at: '' });
      if (request.track) tracker = createTracker((events) => sink!.push(events));
    }

    // Every change: write locally at once, and send what changed as events.
    useViewer.subscribe((s, prev) => {
      if (s.responses && s.responses !== prev.responses) {
        const value = { ...(s.responses as Responses), id } as Stored;
        void saveLocal(store, value).then((ok) => useViewer.getState().setLocalSaved(ok));
        sink?.push(diffResponses(prev.responses, s.responses));
      }
      if (tracker && s.pages !== prev.pages) {
        const shown = s.pages[request.documents[0]!.id];
        if (shown) tracker.page(shown.url, shown.title);
      }
    });
  } catch (e) {
    useViewer.getState().fail((e as Error).message);
  }
  createRoot(root).render(<App sink={sink} tracker={tracker} />);
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
