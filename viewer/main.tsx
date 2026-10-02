/**
 * Viewer entry: load the request, work out who is reading, restore their
 * answers, wire saving, render.
 */
import { createRoot } from 'react-dom/client';
import { Responses } from '../src/spec';
import { App } from './App';
import { loadRequest } from './load';
import { createHttpSink, defaultStore, loadLocal, mergeResponses, saveLocal, type HttpSink, type Stored } from './persist';
import { useViewer } from './state';
import './styles.css';

async function boot() {
  const store = defaultStore();
  let sink: HttpSink | null = null;
  try {
    const { request, origin, reader: readerParam } = await loadRequest();
    document.title = request.title;
    const v = useViewer.getState();
    if (request.sink.kind === 'http') {
      sink = createHttpSink(request.sink.url, request.id, (s) => useViewer.getState().setSink(s));
      v.setSink({ kind: 'sent', at: '' });
    }
    const user = sink ? await sink.whoami() : null;
    v.setServerUser(user);
    const match =
      request.readers.find((r) => (user && r.email === user) || (readerParam && r.id === readerParam)) ??
      (request.readers.length === 1 && !readerParam ? request.readers[0] : undefined);
    const key = match?.id ?? user ?? readerParam ?? 'me';
    const reader = { ...match, key };
    if (sink && origin !== 'spec') await sink.register(request);

    const id = `${request.id}:${key}`;
    const blank: Stored = {
      ...Responses.parse({ request: request.id, reader: { id: match?.id ?? readerParam, name: match?.name, email: match?.email ?? user ?? undefined }, updatedAt: new Date().toISOString() }),
      id,
    };
    let responses: Stored = mergeResponses(blank, await loadLocal(store, id));
    if (sink) responses = mergeResponses(responses, await sink.mine());
    v.init({ request, reader, responses });

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
  createRoot(document.getElementById('root')!).render(<App sink={sink} />);
}

void boot();
