/**
 * Collecting: from many readers' responses to one view of where things stand.
 *
 * Works on tones, not on preset values, so the same rule covers every response
 * type: an item is `blocked` if any answer is blocking, `discuss` if any needs
 * attention, `aligned` when every expected reader answered positively, `pending`
 * while an expected reader has not answered, `neutral` otherwise. An answer
 * given to a passage that has since changed is `stale`.
 */
import { resolveResponseType } from './presets';
import { Responses, type Answer, type Item, type Request, type Tone } from './spec';

export type ItemStatus = 'blocked' | 'discuss' | 'pending' | 'aligned' | 'neutral';

export interface ReaderAnswer {
  reader: string;
  value?: Answer['value'];
  labels: string[];
  tone?: Tone;
  comment?: string;
  at?: string;
  stale: boolean;
}

export interface ItemSummary {
  id: string;
  title?: string;
  prompt: string;
  priority: Item['priority'];
  status: ItemStatus;
  answers: ReaderAnswer[];
  missing: string[];
}

export interface Summary {
  request: string;
  title: string;
  readers: Array<{ reader: string; answered: number; expected: number; finished: boolean; updatedAt?: string }>;
  counts: Record<ItemStatus, number>;
  items: ItemSummary[];
  extras: Array<{ reader: string; quote?: string; section?: string; comment: string; at: string }>;
}

/**
 * Parse responses from anything JSON-ish; drops (and reports) what does not belong to the request.
 * A server's record (`{responses, by, at}`) keeps its `by`; a bare responses document (a reply
 * link, a download) is the reader's own claim, so any `by` in it is dropped.
 */
export function parseResponses(values: unknown[], request?: Pick<Request, 'id'>) {
  const ok: Responses[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  values.forEach((v, index) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const wrapped = 'responses' in o && !('answers' in o);
    const inner = (wrapped ? o.responses : o) as Record<string, unknown>;
    const { by: _claimed, ...rest } = inner ?? {};
    const candidate = wrapped && typeof o.by === 'string' ? { ...rest, by: o.by } : rest;
    const p = Responses.safeParse(candidate);
    if (!p.success) return rejected.push({ index, reason: p.error.issues[0]?.message ?? 'not a responses document' });
    if (request && p.data.request !== request.id) return rejected.push({ index, reason: `belongs to request ${p.data.request}` });
    ok.push(p.data);
  });
  return { responses: ok, rejected };
}

/** Who a responses document is from: the server-asserted identity first, then the reader's own. */
export const readerKey = (r: Responses) => (r.by ?? r.reader.email)?.toLowerCase() ?? r.reader.id ?? r.reader.name ?? 'anonymous';

/**
 * Merge two copies of one reader's responses: per answer the higher `(rev, at)` wins; extras are
 * unioned by id, minus any either copy removed. Two tabs or two devices each hold a whole copy;
 * merging instead of keeping the newer one means neither erases the other.
 */
export function mergeResponses<T extends Responses>(a: T, b: Responses | undefined): T {
  if (!b) return a;
  const answers = { ...a.answers };
  for (const [k, v] of Object.entries(b.answers)) {
    const mine = answers[k];
    if (!mine || mine.rev < v.rev || (mine.rev === v.rev && mine.at < v.at)) answers[k] = v;
  }
  const removed = [...new Set([...(a.removed ?? []), ...(b.removed ?? [])])];
  const gone = new Set(removed);
  const ids = new Set(a.extras.map((x) => x.id));
  const extras = [...a.extras, ...b.extras.filter((x) => !ids.has(x.id))].filter((x) => !gone.has(x.id));
  return {
    ...a,
    answers,
    extras,
    removed,
    updatedAt: a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt,
    finishedAt: a.finishedAt ?? b.finishedAt,
  };
}

/** One responses document per reader: all of that reader's saves, merged (see `mergeResponses`). */
export function latestPerReader(all: Responses[]): Responses[] {
  const m = new Map<string, Responses>();
  for (const r of [...all].sort((x, y) => (x.updatedAt < y.updatedAt ? -1 : 1))) {
    const k = readerKey(r);
    const prev = m.get(k);
    m.set(k, prev ? mergeResponses(r, prev) : r);
  }
  return [...m.values()];
}

const RANK: Record<ItemStatus, number> = { blocked: 0, discuss: 1, pending: 2, neutral: 3, aligned: 4 };

export function summarize(request: Request, all: Responses[]): Summary {
  const latest = latestPerReader(all);
  // Expected readers: the request's, matched to responses by id or email; plus anyone who answered.
  const keyOfReader = new Map<string, string>();
  for (const rd of request.readers) {
    const email = rd.email?.toLowerCase();
    // A server-asserted identity is matched on its own; only unattributed responses match by claimed id or email.
    const r = latest.find((x) => (x.by ? x.by.toLowerCase() === email : (!!email && x.reader.email?.toLowerCase() === email) || x.reader.id === rd.id));
    keyOfReader.set(rd.id, r ? readerKey(r) : email ?? rd.id);
  }
  const respondents = new Set(latest.map(readerKey));
  const byKey = new Map(latest.map((r) => [readerKey(r), r]));
  const hasAnswer = (key: string, itemId: string) => {
    const a = byKey.get(key)?.answers[itemId];
    return !!a && (a.value !== undefined || !!a.comment);
  };
  /** Who should answer this item: its readers, else the request's, else everyone who responded. */
  const expectedFor = (item: Item): string[] => {
    const ids = item.readers ?? request.readers.map((r) => r.id);
    return ids.length ? ids.map((id) => keyOfReader.get(id) ?? id) : [...respondents];
  };
  const answerersOf = (item: Item) => [...new Set([...expectedFor(item), ...[...respondents].filter((k) => hasAnswer(k, item.id))])];

  const items: ItemSummary[] = request.items.map((item) => {
    const rt = resolveResponseType(item, request);
    const answers: ReaderAnswer[] = [];
    const missing: string[] = [];
    for (const key of answerersOf(item)) {
      const a = byKey.get(key)?.answers[item.id];
      if (!a || !hasAnswer(key, item.id)) {
        missing.push(key);
        continue;
      }
      const values = a.value === true ? [rt.options[0]?.value ?? 'read'] : a.value === undefined ? [] : ([] as string[]).concat(a.value);
      const opts = values.map((v) => rt.options.find((o) => o.value === v));
      const tones = opts.map((o) => o?.tone).filter((t): t is Tone => !!t);
      const tone: Tone | undefined = (['blocking', 'attention', 'positive', 'neutral'] as Tone[]).find((t) => tones.includes(t)) ?? (a.comment ? 'neutral' : undefined);
      answers.push({
        reader: key,
        value: a.value,
        labels: opts.map((o, i) => o?.label ?? values[i]!),
        tone,
        comment: a.comment,
        at: a.at,
        stale: !!(item.passageHash && a.passageHash && item.passageHash !== a.passageHash),
      });
    }
    const tones = answers.map((a) => a.tone);
    const status: ItemStatus = tones.includes('blocking')
      ? 'blocked'
      : tones.includes('attention')
        ? 'discuss'
        : missing.length
          ? 'pending'
          : !answers.length
            ? 'pending'
            : tones.every((t) => t === 'positive')
              ? 'aligned'
              : 'neutral';
    return { id: item.id, title: item.title, prompt: item.prompt, priority: item.priority, status, answers, missing };
  });

  const counts = { blocked: 0, discuss: 0, pending: 0, aligned: 0, neutral: 0 } as Record<ItemStatus, number>;
  for (const it of items) counts[it.status]++;
  const readers = [...new Set([...request.readers.map((r) => keyOfReader.get(r.id)!), ...respondents])].map((key) => {
    const r = byKey.get(key);
    const expected = request.items.filter((it) => expectedFor(it).includes(key)).length;
    const answered = request.items.filter((it) => hasAnswer(key, it.id)).length;
    return { reader: key, answered, expected, finished: !!r?.finishedAt, updatedAt: r?.updatedAt };
  });
  const extras = latest.flatMap((r) =>
    r.extras.map((x) => ({ reader: readerKey(r), quote: x.target.quote?.exact, section: x.target.section, comment: x.comment, at: x.at })),
  );
  items.sort((a, b) => RANK[a.status] - RANK[b.status]);
  return { request: request.id, title: request.title, readers, counts, items, extras };
}

const ICON: Record<ItemStatus, string> = { blocked: '⛔', discuss: '💬', pending: '⏳', neutral: '·', aligned: '✅' };

/** The summary as Markdown, worst first: what needs talking about, then what is waiting, then what is settled. */
export function summaryMarkdown(s: Summary): string {
  const out: string[] = [`# ${s.title} — responses`, ''];
  out.push(
    `**${s.counts.blocked} blocked · ${s.counts.discuss} to discuss · ${s.counts.pending} waiting · ${s.counts.aligned} aligned · ${s.counts.neutral} neutral**`,
    '',
  );
  for (const r of s.readers) out.push(`- ${r.reader}: ${r.answered}/${r.expected} answered${r.finished ? ', finished' : ''}${r.updatedAt ? ` (last ${r.updatedAt})` : ''}`);
  out.push('');
  for (const it of s.items) {
    out.push(`## ${ICON[it.status]} ${it.title ?? it.id} — ${it.status} (${it.priority})`, '', `> ${it.prompt.replace(/\n/g, ' ')}`, '');
    for (const a of it.answers) {
      out.push(`- **${a.reader}**: ${a.labels.join(', ') || '(comment)'}${a.stale ? ' *(passage changed since)*' : ''}${a.comment ? ` — ${a.comment.replace(/\n/g, ' ')}` : ''}`);
    }
    if (it.missing.length) out.push(`- not yet: ${it.missing.join(', ')}`);
    out.push('');
  }
  if (s.extras.length) {
    out.push('## Other annotations', '');
    for (const x of s.extras) out.push(`- **${x.reader}**${x.quote ? ` on “${x.quote.slice(0, 120)}”` : ''}: ${x.comment.replace(/\n/g, ' ')}`);
    out.push('');
  }
  return out.join('\n');
}
