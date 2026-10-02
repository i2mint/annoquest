/**
 * Viewer state (zustand + immer): the request, who is reading, their answers,
 * where they are in the queue, and how saving is going.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { PRIORITIES, type Answer, type Extra, type Item, type Mode, type Priority, type Reader, type Request, type Responses } from '../src/spec';
import { resolveResponseType } from '../src/presets';
import type { SinkState } from './persist';

export type View = 'intro' | 'item' | 'pause' | 'done';

export interface ViewerState {
  request: Request | null;
  error: string | null;
  reader: Partial<Reader> & { key: string };
  /** The identity the server asserted (http sink). */
  serverUser: string | null;
  responses: Responses | null;
  view: View;
  current: string | null;
  sink: SinkState;
  localSaved: boolean;
  /** The requester is looking at their own request: nothing is sent. */
  preview: boolean;
  /** Fresh passage hashes from the live document, per item. */
  seen: Record<string, string | undefined>;
  init(p: { request: Request; reader: Partial<Reader> & { key: string }; responses: Responses }): void;
  fail(message: string): void;
  setServerUser(user: string | null): void;
  setView(v: View): void;
  go(id: string | null): void;
  answer(itemId: string, patch: Partial<Pick<Answer, 'value' | 'comment'>>): void;
  addExtra(x: Omit<Extra, 'id' | 'at'>): void;
  removeExtra(id: string): void;
  finish(): void;
  setSink(s: SinkState): void;
  setLocalSaved(ok: boolean): void;
  setSeen(id: string, hash: string | undefined): void;
  setName(name: string): void;
  setPreview(on: boolean): void;
}

const now = () => new Date().toISOString();

export const useViewer = create<ViewerState>()(
  immer((set) => ({
    request: null,
    error: null,
    reader: { key: 'me' },
    serverUser: null,
    responses: null,
    view: 'intro',
    current: null,
    sink: { kind: 'local' },
    localSaved: true,
    preview: false,
    seen: {},
    init: ({ request, reader, responses }) =>
      set((s) => {
        s.request = request;
        s.reader = reader;
        s.responses = responses;
        s.view = Object.keys(responses.answers).length ? 'item' : 'intro';
        s.current = null;
      }),
    fail: (message) => set((s) => void (s.error = message)),
    setServerUser: (user) => set((s) => void (s.serverUser = user)),
    setView: (v) => set((s) => void (s.view = v)),
    go: (id) =>
      set((s) => {
        s.current = id;
        s.view = id ? 'item' : s.view;
      }),
    answer: (itemId, patch) =>
      set((s) => {
        if (!s.responses) return;
        const prev = s.responses.answers[itemId];
        const next: Answer = { ...(prev ?? { rev: 0 }), ...patch, at: now(), rev: (prev?.rev ?? 0) + 1, passageHash: s.seen[itemId] ?? prev?.passageHash };
        if (next.value === undefined) delete next.value;
        if (!next.comment) delete next.comment;
        s.responses.answers[itemId] = next;
        s.responses.updatedAt = next.at;
      }),
    addExtra: (x) =>
      set((s) => {
        if (!s.responses) return;
        const at = now();
        s.responses.extras.push({ ...x, id: `x-${Date.now().toString(36)}`, at });
        s.responses.updatedAt = at;
      }),
    removeExtra: (id) =>
      set((s) => {
        if (!s.responses) return;
        s.responses.extras = s.responses.extras.filter((x) => x.id !== id);
        s.responses.removed = [...(s.responses.removed ?? []), id];
        s.responses.updatedAt = now();
      }),
    finish: () =>
      set((s) => {
        if (!s.responses) return;
        s.responses.finishedAt = now();
        s.responses.updatedAt = s.responses.finishedAt;
        s.view = 'done';
      }),
    setSink: (sink) => set((s) => void (s.sink = sink)),
    setLocalSaved: (ok) => set((s) => void (s.localSaved = ok)),
    setPreview: (on) => set((s) => void (s.preview = on)),
    setSeen: (id, hash) => set((s) => void (s.seen[id] = hash)),
    setName: (name) =>
      set((s) => {
        s.reader.name = name || undefined;
        if (s.responses) s.responses.reader = { ...s.responses.reader, name: name || undefined };
      }),
  })),
);

// ---- derived (pure, so they are cheap to test) -----------------------------

export const isQuick = (item: Item, request: Request) => {
  const rt = resolveResponseType(item, request);
  return rt.kind === 'ack' || (typeof item.response === 'string' && item.response === 'noted');
};

/** The reader's items, in guide order: priority tier, quick ones first, then document order. */
export function queue(request: Request, readerId?: string): Item[] {
  const mine = request.items.filter((i) => !i.readers || (readerId !== undefined && i.readers.includes(readerId)));
  const pos = new Map(request.items.map((i, n) => [i.id, n]));
  return [...mine].sort(
    (a, b) =>
      PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) ||
      Number(!isQuick(a, request)) - Number(!isQuick(b, request)) ||
      pos.get(a.id)! - pos.get(b.id)!,
  );
}

export const answered = (r: Responses | null, id: string) => {
  const a = r?.answers[id];
  return !!a && (a.value !== undefined || !!a.comment);
};

export function tiers(items: Item[], r: Responses | null) {
  return PRIORITIES.map((p) => {
    const its = items.filter((i) => i.priority === p);
    return { priority: p as Priority, items: its, done: its.filter((i) => answered(r, i.id)).length, minutes: its.reduce((m, i) => m + (i.minutes ?? 0), 0) };
  }).filter((t) => t.items.length);
}

export const modeOf = (request: Request, reader: Partial<Reader>): Mode => reader.mode ?? request.mode;
