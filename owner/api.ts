/**
 * The owner app's API, as the page reads it (see `annoquest_server.owner`). Responses are
 * parsed with these schemas, so a server that changed shape fails loudly here.
 */
import { z } from 'zod';
import { parseBatches } from '../src/events';
import { Request } from '../src/spec';

export const RequestSummary = z.object({
  id: z.string(),
  title: z.string().nullish(),
  kind: z.enum(['content', 'guided']),
  content: z.string().nullish(),
  items: z.number(),
  revisions: z.number(),
  registeredAt: z.string().nullish(),
  readers: z.number(),
  devices: z.number(),
  events: z.number(),
  lastAt: z.string().nullish(),
});
export type RequestSummary = z.infer<typeof RequestSummary>;

/** Where the API is: `<meta name="annoquest-api">`, else `/api` (the app served alone). */
export const apiBase = (doc: Document = document) => (doc.querySelector<HTMLMetaElement>('meta[name="annoquest-api"]')?.content?.trim() || '/api').replace(/\/$/, '');

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { detail?: string }).detail ?? `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  config: async () => z.object({ viewer: z.string().nullish() }).parse(await call('/config')),
  requests: async () => z.object({ requests: z.array(RequestSummary) }).parse(await call('/requests')).requests,
  request: async (id: string) => Request.parse(await call(`/requests/${encodeURIComponent(id)}`)),
  events: async (id: string) => parseBatches(z.object({ batches: z.array(z.unknown()) }).parse(await call(`/requests/${encodeURIComponent(id)}/events`)).batches),
  link: async (url: string, reader?: string) => z.object({ link: z.string() }).parse(await call('/links', { method: 'POST', body: JSON.stringify({ url, reader: reader || undefined }) })).link,
};
