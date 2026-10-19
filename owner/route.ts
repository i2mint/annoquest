/**
 * The owner page's routes, and the one place that touches `history`.
 *
 * `#/` the requests, `#/r/<id>` one request, `#/r/<id>/<reader>` one reader. Each is a
 * place, so going to one pushes a history entry and Back walks back through them.
 */
import { useSyncExternalStore } from 'react';

export type Route = { view: 'requests' } | { view: 'request'; id: string } | { view: 'reader'; id: string; reader: string };

export function parseRoute(hash: string): Route {
  const [kind, id, reader] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (kind === 'r' && id && reader) return { view: 'reader', id, reader };
  if (kind === 'r' && id) return { view: 'request', id };
  return { view: 'requests' };
}

export function formatRoute(r: Route): string {
  if (r.view === 'reader') return `#/r/${encodeURIComponent(r.id)}/${encodeURIComponent(r.reader)}`;
  if (r.view === 'request') return `#/r/${encodeURIComponent(r.id)}`;
  return '#/';
}

const CHANGED = 'annoquest:route';

export function navigate(r: Route, { replace = false } = {}): void {
  const to = formatRoute(r);
  if (to === (location.hash || '#/')) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  dispatchEvent(new Event(CHANGED));
  if (!replace) scrollTo(0, 0);
}

function subscribe(f: () => void) {
  for (const t of ['popstate', 'hashchange', CHANGED]) addEventListener(t, f);
  return () => {
    for (const t of ['popstate', 'hashchange', CHANGED]) removeEventListener(t, f);
  };
}

export const useHash = () => useSyncExternalStore(subscribe, () => location.hash);
