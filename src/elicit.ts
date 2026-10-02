/**
 * An item as an MCP elicitation: the same question, asked inside a chat.
 *
 * MCP's `elicitation/create` takes a flat object schema of primitives; titled
 * enums (`oneOf` of `{const, title}`) carry the option labels. Use it when one
 * quick question to the current user is enough and a guided page is not needed.
 */
import { commentRequired, resolveResponseType } from './presets';
import type { Item, Request } from './spec';

export interface Elicitation {
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

export function toElicitation(item: Item, request?: Pick<Request, 'responseTypes'>): Elicitation {
  const rt = resolveResponseType(item, request);
  const quote = item.target?.quote?.exact;
  const message = [item.title, quote ? `“${quote}”` : undefined, item.prompt].filter(Boolean).join('\n\n');
  const properties: Elicitation['requestedSchema']['properties'] = {};
  const required: string[] = [];
  const titled = rt.options.map((o) => ({ const: o.value, title: o.label }));
  if (rt.kind === 'ack') {
    properties.answer = { type: 'boolean', title: rt.options[0]?.label ?? 'Done' };
    required.push('answer');
  } else if (rt.kind === 'choice') {
    properties.answer = { type: 'string', title: rt.label ?? 'Answer', oneOf: titled };
    required.push('answer');
  } else if (rt.kind === 'multi') {
    properties.answer = { type: 'array', title: rt.label ?? 'Answer', items: { anyOf: titled } };
  }
  if (item.comment !== 'none') {
    const needs = item.comment === 'required' || rt.kind === 'text';
    const hint = rt.options.filter(commentRequired).map((o) => o.label);
    properties.comment = {
      type: 'string',
      title: 'Comment',
      ...(hint.length ? { description: `Required if you answer: ${hint.join(', ')}` } : {}),
    };
    if (needs) required.push('comment');
  }
  return { message, requestedSchema: { type: 'object', properties, required } };
}
