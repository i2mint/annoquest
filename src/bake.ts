/**
 * Baking: one self-contained HTML file holding the viewer, the request and the
 * document snapshots. The zero-config delivery: host it anywhere, or attach it.
 */
import type { Request } from './spec';

export const REQUEST_SCRIPT_ID = 'annoquest-request';
const MARKER = '<!--annoquest:request-->';

/** JSON that is safe inside a `<script>` element (no `</script>`, no `<!--`). */
export const scriptSafeJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Replace url documents by inline snapshots, from `htmlById` (document id → HTML). */
export function inlineDocuments(request: Request, htmlById: Record<string, string>): Request {
  return {
    ...request,
    documents: request.documents.map((d) => {
      const html = htmlById[d.id];
      if (html === undefined || d.source.kind === 'inline') return d;
      return { ...d, href: d.href ?? d.source.url, source: { kind: 'inline', html, baseUrl: d.source.url } };
    }),
  };
}

/** The viewer page with `request` embedded; the viewer reads it before looking at the URL. */
export function bakeRequest(request: Request, viewerHtml: string): string {
  const tag = `<script type="application/json" id="${REQUEST_SCRIPT_ID}">${scriptSafeJson(request)}</script>`;
  const title = request.title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
  let html = viewerHtml.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  html = html.includes(MARKER) ? html.replace(MARKER, () => tag) : html.replace('</head>', () => `${tag}</head>`);
  return html;
}
