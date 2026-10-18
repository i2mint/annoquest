/**
 * Where the request comes from (the delivery seam, viewer side), in order:
 * a baked `<script id="annoquest-request">`, a `#r=` fragment, a `?spec=` URL,
 * a `?content=` link (any page, freeform; the viewer builds the request).
 */
import { REQUEST_SCRIPT_ID } from '../src/bake';
import { contentRequest } from '../src/content';
import { decodePayload } from '../src/link';
import { parseRequest } from '../src/request';
import type { Request } from '../src/spec';

export type Origin = 'baked' | 'fragment' | 'spec' | 'content';

export interface Loaded {
  request: Request;
  origin: Origin;
  /** `?reader=` (or its alias `?user_id=`) from the link. */
  reader?: string;
}

/**
 * The annoquest server's API as this page reaches it: a `<meta name="annoquest-api">` written
 * into the page by its host (a platform that mounts the API elsewhere), else `/api`.
 */
export const apiBase = (doc: Document = document) => doc.querySelector<HTMLMetaElement>('meta[name="annoquest-api"]')?.content?.trim() || '/api';

export async function loadRequest(loc: Location = location, doc: Document = document): Promise<Loaded> {
  const params = new URLSearchParams(loc.search);
  const reader = (params.get('reader') ?? params.get('user_id'))?.trim() || undefined;
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
  const content = params.get('content');
  if (content) {
    const token = params.get('t');
    if (!token) throw new Error('This link is missing its key (the t= part). Ask for the link again.');
    return { request: await contentRequest({ url: content, token, api: apiBase(doc), viewer: loc.href }), origin: 'content', reader };
  }
  throw new Error('This page has no request in it. Open the link you were sent.');
}
