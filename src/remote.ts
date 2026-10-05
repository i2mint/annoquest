/**
 * Talking to an annoquest server: the calls an agent or a page makes on a request it sent.
 *
 * Behind a forward-auth gateway these need the sender's session, so from a script they go
 * through `headers` (a token the gateway accepts) or are left to the viewer: `annoquest revise`
 * prints a link whose preview, opened by the sender, has a Publish button.
 */
import { AnnoquestError } from './errors';
import type { Request } from './spec';

export interface RemoteOptions {
  /** The server's API base, e.g. `https://host/api` or `/api`. */
  api: string;
  headers?: Record<string, string>;
  credentials?: 'omit' | 'same-origin' | 'include';
  fetch?: typeof fetch;
}

/** Publish `request` as a new revision of the request with its id (its sender only). Returns the revision number. */
export async function publishRevision(request: Request, { api, headers = {}, credentials = 'same-origin', fetch: f = fetch }: RemoteOptions): Promise<{ revision: number; created: boolean }> {
  const { revision: _serverSet, ...body } = request;
  const res = await f(`${api.replace(/\/$/, '')}/requests/${encodeURIComponent(request.id)}/revisions`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    credentials,
  });
  const json = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok || typeof json?.revision !== 'number') {
    throw new AnnoquestError('io', `Publishing the revision failed: ${json?.detail ?? `the server answered ${res.status}`}.`);
  }
  return { revision: json.revision, created: !!json.created };
}
