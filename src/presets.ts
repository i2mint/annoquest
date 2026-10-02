/**
 * Built-in response presets: named, data-only response types.
 *
 * Each option carries a tone, so the summary can say aligned / to discuss /
 * blocked for any preset. Sources for the scales: Reviewable dispositions,
 * Gerrit votes, the IETF ballot, Kaner's gradients of agreement, sociocratic
 * consent, MoSCoW (see docs/research/prior-art.md §3).
 *
 * Design rules: blocking options require a reason; every opinion preset has a
 * neutral escape; at most five options in the everyday presets; items should
 * override labels with item-specific wording (`item.labels`).
 */
import type { Item, Option, Request, ResponseType } from './spec';
import { AnnoquestError } from './errors';

const o = (value: string, label: string, tone: Option['tone'], extra: Partial<Option> = {}): Option => ({
  value,
  label,
  tone,
  ...extra,
});

const NA = o('na', 'Not my area', 'neutral');

export const presets: Readonly<Record<string, ResponseType>> = Object.freeze({
  read: { kind: 'ack', label: 'Read', options: [o('read', "I've read this", 'positive')] },
  noted: {
    kind: 'choice',
    label: 'Noted',
    options: [o('noted', 'Noted', 'positive'), o('question', 'I have a question', 'attention', { comment: 'required' })],
  },
  agree: {
    kind: 'choice',
    label: 'Agree?',
    options: [
      o('agree', 'Agree', 'positive'),
      o('reservations', 'Agree, with reservations', 'positive', { comment: 'encouraged' }),
      o('discuss', "Let's discuss", 'attention', { comment: 'encouraged' }),
      o('disagree', 'Disagree', 'blocking', { comment: 'required' }),
      NA,
    ],
  },
  consent: {
    kind: 'choice',
    label: 'Consent?',
    options: [
      o('consent', 'Good enough for now', 'positive'),
      o('concern', 'Concern, but go ahead', 'attention', { comment: 'encouraged' }),
      o('object', 'Objection', 'blocking', { comment: 'required' }),
      o('stand-aside', 'Stand aside', 'neutral'),
    ],
  },
  implement: {
    kind: 'choice',
    label: 'Implementation',
    options: [
      o('done', 'Already implemented', 'positive'),
      o('will', 'Will implement', 'positive'),
      o('discuss', "Let's discuss", 'attention', { comment: 'encouraged' }),
      o('wont', "Won't implement", 'blocking', { comment: 'required' }),
      NA,
    ],
  },
  approve: {
    kind: 'choice',
    label: 'Sign-off',
    options: [
      o('approve', 'Approve', 'positive'),
      o('approve-with-changes', 'Approve with changes', 'positive', { comment: 'required' }),
      o('changes', 'Changes required', 'blocking', { comment: 'required' }),
      o('not-relevant', 'Not relevant to me', 'neutral'),
    ],
  },
  gradient: {
    kind: 'choice',
    label: 'Gradients of agreement',
    options: [
      o('1', 'I like it', 'positive'),
      o('2', 'Basically I like it', 'positive'),
      o('3', 'I can live with it', 'positive'),
      o('4', 'I have no opinion', 'neutral'),
      o('5', "I don't like it, but I won't hold it up", 'neutral'),
      o('6', 'I disagree, but will go with the group', 'attention', { comment: 'encouraged' }),
      o('7', 'I disagree and want no part in implementing it', 'attention', { comment: 'required' }),
      o('8', 'I veto this', 'blocking', { comment: 'required' }),
    ],
  },
  'fist-to-five': {
    kind: 'choice',
    label: 'Fist to five',
    options: [
      o('0', '0 — no, block', 'blocking', { comment: 'required' }),
      o('1', '1 — serious concerns', 'attention', { comment: 'encouraged' }),
      o('2', '2 — some concerns', 'attention'),
      o('3', '3 — can live with it', 'positive'),
      o('4', '4 — good', 'positive'),
      o('5', '5 — great', 'positive'),
    ],
  },
  moscow: {
    kind: 'choice',
    label: 'How important is this?',
    options: [
      o('must', 'Must have', 'neutral'),
      o('should', 'Should have', 'neutral'),
      o('could', 'Could have', 'neutral'),
      o('wont', "Won't have (this time)", 'neutral'),
    ],
  },
  comment: { kind: 'text', label: 'Comment', options: [] },
  label: { kind: 'choice', label: 'Label', options: [] },
});

/** The response type an item uses, with the request's custom presets and the item's labels applied. */
export function resolveResponseType(item: Pick<Item, 'response' | 'labels' | 'id'>, request?: Pick<Request, 'responseTypes'>): ResponseType {
  let rt: ResponseType | undefined;
  if (typeof item.response === 'string') {
    rt = request?.responseTypes?.[item.response] ?? presets[item.response];
    if (!rt) {
      const known = [...Object.keys(request?.responseTypes ?? {}), ...Object.keys(presets)].join(', ');
      throw new AnnoquestError('invalid', `Item "${item.id}" uses response type "${item.response}", which does not exist. Known: ${known}.`);
    }
  } else {
    rt = item.response;
  }
  if (!item.labels) return rt;
  return { ...rt, options: rt.options.map((opt) => (item.labels?.[opt.value] ? { ...opt, label: item.labels[opt.value]! } : opt)) };
}

/** Whether an answer with this option needs a comment. */
export function commentRequired(opt: Option | undefined): boolean {
  return !!opt && (opt.tone === 'blocking' || opt.comment === 'required');
}
