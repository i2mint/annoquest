/**
 * Comment drafts: the comment a reader is writing (a new one, or an edit of a saved one) is
 * kept in device storage as they type, so a reload or a closed tab does not lose it. A draft
 * belongs to one request and one reader, in one slot: `new` (at most one open box) or
 * `edit:<comment id>`. Saving or cancelling clears it. While any draft is open, the page
 * asks before it unloads.
 *
 * Why device storage and not an autosaved comment event: a draft the reader has not chosen to
 * send stays theirs (nothing reaches the server, nothing to retract), the event log keeps one
 * meaning ("saved"), and it works offline. The cost is that a lost device loses the draft;
 * saved comments already survive that.
 */
import type { Target } from '../src/spec';

export type DraftValue =
  /** A new comment on a selected passage: what is needed to reopen the box. */
  | { kind: 'new'; doc: string; target: Target; text: string; url?: string; comment: string }
  /** An edit of the saved comment `id`. */
  | { kind: 'edit'; id: string; comment: string };

export type Slot = 'new' | `edit:${string}`;
export const slotOf = (d: DraftValue): Slot => (d.kind === 'new' ? 'new' : `edit:${d.id}`);

export interface DraftsOptions {
  /** Where drafts are kept (default: localStorage). */
  storage?: () => Storage;
  /** Quiet time after a keystroke before it is written. */
  delay?: number;
}

export interface Drafts {
  /** The kept draft for a slot, if any. */
  get(slot: Slot): DraftValue | undefined;
  /** Every kept draft (to restore what was open). */
  all(): DraftValue[];
  /** Note the box's current content: written after `delay`. A blank draft (`value` null) is cleared. */
  set(slot: Slot, value: DraftValue | null): void;
  /** Write what is waiting, now. */
  flush(): void;
  /** Whether any draft is open (not yet saved or cancelled). */
  readonly unsaved: boolean;
}

const PREFIX = 'annoquest:draft:';

export function createDrafts(scope: { request: string; reader: string }, { storage = () => localStorage, delay = 400 }: DraftsOptions = {}): Drafts {
  const base = `${PREFIX}${scope.request}:${scope.reader}:`;
  /** Open drafts: what the boxes hold now (possibly not yet written). */
  const open = new Map<Slot, DraftValue>();
  const timers = new Map<Slot, ReturnType<typeof setTimeout>>();

  const write = (slot: Slot, value: DraftValue | null) => {
    try {
      if (value) storage().setItem(base + slot, JSON.stringify(value));
      else storage().removeItem(base + slot);
    } catch {
      /* storage refused: the draft lasts for this page load */
    }
  };
  const stop = (slot: Slot) => {
    clearTimeout(timers.get(slot));
    timers.delete(slot);
  };
  const read = (key: string): DraftValue | undefined => {
    try {
      const raw = storage().getItem(key);
      return raw ? (JSON.parse(raw) as DraftValue) : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    get: (slot) => read(base + slot),
    all() {
      try {
        const s = storage();
        const keys = Array.from({ length: s.length }, (_, i) => s.key(i)).filter((k): k is string => !!k && k.startsWith(base));
        return keys.map(read).filter((d): d is DraftValue => !!d);
      } catch {
        return [];
      }
    },
    set(slot, value) {
      stop(slot);
      if (!value) {
        open.delete(slot);
        write(slot, null);
        return;
      }
      open.set(slot, value);
      timers.set(slot, setTimeout(() => {
        timers.delete(slot);
        write(slot, value);
      }, delay));
    },
    flush() {
      for (const slot of [...timers.keys()]) {
        stop(slot);
        const v = open.get(slot);
        if (v) write(slot, v);
      }
    },
    get unsaved() {
      return open.size > 0;
    },
  };
}

/** The drafts of the reader on screen; bound once the request and reader are known. */
let current: Drafts | null = null;
export const bindDrafts = (d: Drafts | null) => void (current = d);
export const drafts = (): Drafts | null => current;

/** Ask before the page goes away while a draft is open; write what is waiting either way. Returns the remover. */
export function guardUnload(d: Drafts, win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const leaving = (e: Event) => {
    d.flush();
    if (d.unsaved) {
      e.preventDefault();
      (e as BeforeUnloadEvent).returnValue = '';
    }
  };
  const hide = () => d.flush();
  win.addEventListener('beforeunload', leaving);
  win.addEventListener('pagehide', hide);
  return () => {
    win.removeEventListener('beforeunload', leaving);
    win.removeEventListener('pagehide', hide);
  };
}
