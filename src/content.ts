/**
 * Content links: any page opened for freeform annotation from one link,
 * `<viewer>?content=<url>&t=<token>[&reader=<id>]`.
 *
 * The viewer builds the request itself: one document, no items, freeform and
 * tracked, the default instructions, the server's sink. Its id is derived from
 * the token and the URL, so every reader of one link lands in one request and
 * the server can check that the request is the one the token allows (the token
 * is the server's HMAC of the page's site: see `annoquest_server.content`).
 *
 * A page on the viewer's own origin is framed directly, with its scripts (it runs
 * on this origin anyway); any other page goes through the server's proxy, which
 * serves it without scripts and rewrites its links back through itself.
 */
import { toBase64Url } from './link';
import { Request } from './spec';

/** The instructions a content link opens with; they double as the notice that reading is recorded. */
export const CONTENT_INTRO =
  'Read through the page and highlight any passage to comment on it. There is nothing to save or submit: everything you do here is sent automatically as you go, including which pages you open and how long you spend on each. You can come back to this link and edit your comments at any time.';

/** `c-` + 22 base64url chars of SHA-256(token + "\n" + url): the same computation as the server's. */
export async function contentRequestId(url: string, token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${token}\n${url}`));
  return `c-${toBase64Url(new Uint8Array(digest)).slice(0, 22)}`;
}

/** The link to send for a page: the viewer with the page, its site's token and optionally a reader (as the server's `content_link`). */
export function contentLink(viewer: string, url: string, token: string, { reader }: { reader?: string } = {}): string {
  const q = new URLSearchParams({ content: url, t: token, ...(reader ? { reader } : {}) });
  return `${viewer}${viewer.includes('?') ? '&' : '?'}${q}`;
}

/** The proxy address of a page (the server serves it script-less, its links rewritten back through itself). */
export const proxyUrl = (api: string, url: string, token: string) => `${api.replace(/\/$/, '')}/proxy?u=${encodeURIComponent(url)}&t=${encodeURIComponent(token)}`;

/** The original address of a proxied page (or the address itself when it is not one). */
export function originalUrl(address: string, base?: string): string {
  try {
    const u = new URL(address, base);
    return u.pathname.endsWith('/proxy') && u.searchParams.get('u') ? u.searchParams.get('u')! : u.href;
  } catch {
    return address;
  }
}

/**
 * Where a page is, as a page: its address without the fragment, unless the fragment is an
 * in-app route (`#/…`, `#!…`), which is a page of its own in a single-page app.
 */
export function pageKey(address: string): string {
  const i = address.indexOf('#');
  if (i === -1) return address;
  const frag = address.slice(i + 1);
  return frag.startsWith('/') || frag.startsWith('!') ? address : address.slice(0, i);
}

export interface ContentOptions {
  /** The page to annotate (absolute, or relative to `viewer`). */
  url: string;
  token: string;
  /** The server's API, as the viewer reaches it (e.g. `/api/annoquest`). */
  api: string;
  /** The viewer's own address, to tell a same-origin page from another site's. */
  viewer: string;
  title?: string;
  intro?: string;
}

/** The request a content link stands for. */
export async function contentRequest({ url, token, api, viewer, title, intro = CONTENT_INTRO }: ContentOptions): Promise<Request> {
  const page = new URL(url, viewer);
  const href = page.href;
  const sameOrigin = page.origin === new URL(viewer).origin;
  return Request.parse({
    id: await contentRequestId(href, token),
    title: title ?? `${page.hostname}${page.pathname === '/' ? '' : page.pathname}`,
    intro,
    documents: [{ id: 'page', title: page.hostname, href, source: sameOrigin ? { kind: 'url', url: href, scripts: true } : { kind: 'url', url: proxyUrl(api, href, token) } }],
    items: [],
    allowExtra: true,
    track: true,
    sink: { kind: 'http', url: api },
    content: { url: href, token },
  });
}
