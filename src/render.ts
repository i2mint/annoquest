/**
 * A read-only view of a request as Markdown or plain text: the intro, then the
 * items grouped by priority, each with its prompt, its answer options and its
 * target. For a requester who can't open the live viewer (e.g. on a phone).
 */
import { resolveResponseType } from './presets';
import { PRIORITIES, type Item, type Request } from './spec';

export type RenderFormat = 'markdown' | 'text';

const answerOf = (item: Item, request: Request): string => {
  const rt = resolveResponseType(item, request);
  if (rt.options.length) return rt.options.map((o) => o.label).join(' / ');
  return rt.label ?? (rt.kind === 'text' ? 'a free comment' : 'tick when read');
};

const stripMarkdown = (s: string) => s.replace(/[*`]/g, '');

/** `request` as a read-only document; `link` (the live request) is shown when given. */
export function renderRequest(request: Request, { format = 'markdown', link }: { format?: RenderFormat; link?: string } = {}): string {
  const md = format === 'markdown';
  const heading = (level: number, text: string) => (md ? `${'#'.repeat(level)} ${text}` : level === 1 ? `${text}\n${'='.repeat(text.length)}` : `${text}\n${'-'.repeat(text.length)}`);
  const lines: string[] = [heading(1, request.title), ''];
  if (link) lines.push(`Live request: ${link}`, '');
  if (request.intro) lines.push(request.intro, '');
  const number = new Map(request.items.map((it, i) => [it.id, i + 1]));
  for (const priority of PRIORITIES) {
    const items = request.items.filter((it) => it.priority === priority);
    if (!items.length) continue;
    lines.push(heading(2, `${priority[0]!.toUpperCase()}${priority.slice(1)} (${items.length})`), '');
    for (const it of items) {
      const title = `${number.get(it.id)}. ${it.title ?? it.id}`;
      lines.push(md ? `**${title}**` : title, '', it.prompt, '');
      if (it.target?.quote?.exact) lines.push(md ? `> ${it.target.quote.exact}` : `"${it.target.quote.exact}"`, '');
      const section = it.target?.section;
      lines.push(`Answer: ${answerOf(it, request)}${section ? (md ? ` · Doc section: \`#${section}\`` : ` · Doc section: #${section}`) : ''}`, '');
    }
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  return md ? text : stripMarkdown(text);
}
