/**
 * Links: a request (or a reader's responses) carried in a URL fragment.
 *
 * The payload grammar is holdall's (`z1.` raw DEFLATE + base64url, `j1.` plain
 * JSON + base64url, the shorter wins), so links made here decode there and back.
 * seam candidate: import holdall's `encodePayload`/`decodePayload` once holdall
 * is on npm (https://github.com/i2mint/holdall/issues/2).
 *
 * Fragments are never sent to a server and never logged, which is why the
 * request rides there and not in the query string.
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { AnnoquestError } from './errors';
import type { Request, Responses } from './spec';

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new AnnoquestError('bad-payload', 'The link payload has characters base64url does not use. Was it cut or edited?');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function encodePayload(value: unknown): string {
  const bytes = strToU8(JSON.stringify(value));
  const z1 = 'z1.' + toBase64Url(deflateSync(bytes, { level: 9 }));
  const j1 = 'j1.' + toBase64Url(bytes);
  return z1.length <= j1.length ? z1 : j1;
}

/** Links come from strangers: refuse payloads that inflate past this. */
export const MAX_DECODED_BYTES = 16 * 1024 * 1024;

export function decodePayload(payload: string, { maxBytes = MAX_DECODED_BYTES } = {}): unknown {
  const dot = payload.indexOf('.');
  const codec = payload.slice(0, dot);
  const body = fromBase64Url(payload.slice(dot + 1));
  let bytes: Uint8Array;
  if (codec === 'j1') bytes = body;
  else if (codec === 'z1') {
    try {
      bytes = inflateSync(body);
    } catch (e) {
      throw new AnnoquestError('bad-payload', 'The link payload is damaged (it does not inflate). Was the link cut short?', e);
    }
  } else throw new AnnoquestError('bad-payload', `Unknown link codec "${codec}".`);
  if (bytes.length > maxBytes) throw new AnnoquestError('bad-payload', `The link payload expands past ${maxBytes} bytes; refusing it.`);
  try {
    return JSON.parse(strFromU8(bytes));
  } catch (e) {
    throw new AnnoquestError('bad-payload', 'The link payload is not JSON.', e);
  }
}

/** Rough deliverability of a URL by length (email clients break long links first). */
export function linkTier(url: string): 'email' | 'chat' | 'too-long' {
  return url.length <= 2000 ? 'email' : url.length <= 64000 ? 'chat' : 'too-long';
}

export interface RequestLinkOptions {
  /** A reader id, added as `?reader=` so a local sink can attribute answers. */
  reader?: string;
}

/** A link to `viewerUrl` carrying the request in its fragment (`#r=`). */
export function requestLink(request: Request, viewerUrl: string, { reader }: RequestLinkOptions = {}) {
  const u = new URL(viewerUrl);
  if (reader) u.searchParams.set('reader', reader);
  u.hash = 'r=' + encodePayload(request);
  const url = u.toString();
  return { url, length: url.length, tier: linkTier(url) };
}

/** A link to `viewerUrl` that loads the request from a URL (`?spec=`), e.g. an annoquest server's `/api/requests/<id>`. */
export function specLink(specUrl: string, viewerUrl: string, { reader }: RequestLinkOptions = {}) {
  const u = new URL(viewerUrl);
  u.searchParams.set('spec', specUrl);
  if (reader) u.searchParams.set('reader', reader);
  const url = u.toString();
  return { url, length: url.length, tier: linkTier(url) };
}

/** A reply link: the reader's responses in a fragment (`#a=`), for the local sink. */
export function replyLink(responses: Responses, viewerUrl: string) {
  const u = new URL(viewerUrl);
  u.search = '';
  u.hash = 'a=' + encodePayload(responses);
  const url = u.toString();
  return { url, length: url.length, tier: linkTier(url) };
}

/** Read a `#r=` or `#a=` payload from a URL (or a bare fragment). */
export function readLink(url: string): { request?: unknown; responses?: unknown } {
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : url;
  const params = new URLSearchParams(hash);
  const r = params.get('r');
  const a = params.get('a');
  return { ...(r ? { request: decodePayload(r) } : {}), ...(a ? { responses: decodePayload(a) } : {}) };
}
