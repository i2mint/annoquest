/**
 * Where the request comes from (the delivery seam, viewer side), in order:
 * a baked `<script id="annoquest-request">`, a `#r=` fragment, a `?spec=` URL.
 */
import { REQUEST_SCRIPT_ID } from '../src/bake';
import { decodePayload } from '../src/link';
import { parseRequest } from '../src/request';
import type { Request } from '../src/spec';

export type Origin = 'baked' | 'fragment' | 'spec';

export interface Loaded {
  request: Request;
  origin: Origin;
  /** `?reader=` from the link. */
  reader?: string;
}

export async function loadRequest(loc: Location = location, doc: Document = document): Promise<Loaded> {
  const params = new URLSearchParams(loc.search);
  const reader = params.get('reader') ?? undefined;
  const baked = doc.getElementById(REQUEST_SCRIPT_ID)?.textContent;
  if (baked?.trim()) return { request: parseRequest(JSON.parse(baked)), origin: 'baked', reader };
  const r = new URLSearchParams(loc.hash.slice(1)).get('r');
  if (r) return { request: parseRequest(decodePayload(r)), origin: 'fragment', reader };
  const spec = params.get('spec');
  if (spec) {
    const res = await fetch(spec, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status === 401) throw new Error('You need to sign in to open this request. Reload the page to sign in.');
    if (res.status === 403) throw new Error('This request was not sent to you.');
    if (!res.ok) throw new Error(`The request could not be loaded (${res.status}).`);
    return { request: parseRequest(await res.json()), origin: 'spec', reader };
  }
  throw new Error('This page has no request in it. Open the link you were sent.');
}
