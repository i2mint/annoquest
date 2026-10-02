#!/usr/bin/env node
/**
 * The annoquest CLI: the agent primitives, one command each.
 *
 * JSON on stdout (or Markdown where asked), a JSON error on stderr with a
 * non-zero exit, nothing interactive. `annoquest help` lists the commands.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { bakeRequest, inlineDocuments } from './bake';
import { parseResponses, summarize, summaryMarkdown } from './collect';
import { toElicitation } from './elicit';
import { AnnoquestError } from './errors';
import { readLink, requestLink, specLink } from './link';
import { presets } from './presets';
import { checkRequest, createRequest, parseRequest, type CreateInput } from './request';
import { Request, Responses, type Request as RequestT } from './spec';

const HELP = `annoquest — guided annotation requests

  annoquest create <input.json> [--out request.json]     fill ids and defaults, validate
  annoquest check <request.json> [--doc id=path|url]... [--write]
                                                         resolve every item's passage; exit 1 if any fails
  annoquest bake <request.json> [--out page.html] [--doc id=path|url]... [--inline] [--no-check]
                                                         one self-contained HTML page (viewer + request [+ snapshots])
  annoquest link <request.json> --viewer <url> [--reader id] [--spec-url url]
                                                         a link carrying the request (#r=) or pointing at it (?spec=)
  annoquest collect <file|dir|reply-link>... --request <request.json> [--format json|markdown]
                                                         summarise responses: blocked, to discuss, waiting, aligned
  annoquest elicit <request.json> <item-id>               one item as an MCP elicitation schema
  annoquest presets                                      the built-in response types
  annoquest schema [request|responses]                   JSON Schema of the spec

Errors go to stderr as {"error": {"code", "message"}}.`;

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new AnnoquestError('io', `Could not read JSON from ${path}: ${(e as Error).message}`);
  }
};

const out = (value: unknown) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');

/** `id=path-or-url` pairs into a map. */
function docArgs(values: string[] | undefined): Record<string, string> {
  const m: Record<string, string> = {};
  for (const v of values ?? []) {
    const i = v.indexOf('=');
    if (i < 1) throw new AnnoquestError('invalid', `--doc wants id=path-or-url, got "${v}".`);
    m[v.slice(0, i)] = v.slice(i + 1);
  }
  return m;
}

async function fetchText(where: string, base: string, { confine = false } = {}): Promise<string> {
  if (/^https?:\/\//.test(where)) {
    const res = await fetch(where, { headers: { Accept: 'text/html' } });
    if (!res.ok) throw new AnnoquestError('io', `GET ${where} answered ${res.status}. If it is behind a login, save the page and pass --doc <id>=<file>.`);
    return res.text();
  }
  const p = resolve(base, where.replace(/^\/+/, confine ? '' : '/'));
  // A request file names its own documents; it may not reach outside its folder (pass --doc for that).
  if (confine && !p.startsWith(resolve(base) + sep)) throw new AnnoquestError('io', `Document "${where}" is outside the request's folder; pass --doc <id>=<path> to use it.`);
  if (!existsSync(p)) throw new AnnoquestError('io', `No file at ${p}. Pass --doc <id>=<path> to say where the document is.`);
  return readFileSync(p, 'utf8');
}

/** Each document's HTML: from --doc, else inline, else its url (fetched, or read relative to the request file). */
async function loadDocuments(request: RequestT, overrides: Record<string, string>, base: string) {
  const html: Record<string, string> = {};
  for (const d of request.documents) {
    if (overrides[d.id]) html[d.id] = await fetchText(overrides[d.id]!, process.cwd());
    else if (d.source.kind === 'inline') html[d.id] = d.source.html;
    else html[d.id] = await fetchText(d.source.url, base, { confine: true });
  }
  return html;
}

const parseDom = (html: string) => parseHTML(html).document as unknown as Document;

function viewerHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, 'viewer.html'), join(here, '..', 'dist', 'viewer.html')]) if (existsSync(p)) return readFileSync(p, 'utf8');
  throw new AnnoquestError('io', 'The built viewer (dist/viewer.html) is missing; run `pnpm build`.');
}

function collectInputs(args: string[]): unknown[] {
  const values: unknown[] = [];
  const visit = (p: string) => {
    if (/^https?:\/\//.test(p) || p.startsWith('#')) {
      const { responses } = readLink(p);
      if (responses) values.push(responses);
      return;
    }
    const st = statSync(p);
    if (st.isDirectory()) for (const f of readdirSync(p).sort()) visit(join(p, f));
    else if (p.endsWith('.json')) values.push(readJson(p));
  };
  args.forEach(visit);
  return values;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      doc: { type: 'string', multiple: true },
      write: { type: 'boolean' },
      inline: { type: 'boolean' },
      'no-check': { type: 'boolean' },
      viewer: { type: 'string' },
      reader: { type: 'string' },
      'spec-url': { type: 'string' },
      request: { type: 'string' },
      format: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const requestAt = (p: string | undefined) => {
    if (!p) throw new AnnoquestError('invalid', `\`annoquest ${cmd}\` needs a request file.`);
    return { request: parseRequest(readJson(p)), base: dirname(resolve(p)), path: p };
  };

  switch (cmd) {
    case 'create': {
      const req = createRequest(readJson(positionals[0] ?? '/dev/stdin') as CreateInput);
      if (values.out) writeFileSync(values.out, JSON.stringify(req, null, 2) + '\n');
      out(values.out ? { ok: true, out: values.out, id: req.id, items: req.items.length } : req);
      return 0;
    }
    case 'check': {
      const { request, base, path } = requestAt(positionals[0]);
      const html = await loadDocuments(request, docArgs(values.doc), base);
      const report = checkRequest(request, Object.fromEntries(Object.entries(html).map(([k, v]) => [k, parseDom(v)])));
      if (values.write && report.ok) writeFileSync(path, JSON.stringify(report.request, null, 2) + '\n');
      out({ ok: report.ok, items: report.items.map(({ passage, ...r }) => ({ ...r, passage: passage?.slice(0, 120) })) });
      return report.ok ? 0 : 1;
    }
    case 'bake': {
      let { request, base } = requestAt(positionals[0]);
      const html = await loadDocuments(request, docArgs(values.doc), base);
      if (!values['no-check']) {
        const report = checkRequest(request, Object.fromEntries(Object.entries(html).map(([k, v]) => [k, parseDom(v)])));
        if (!report.ok) {
          out({ ok: false, items: report.items.filter((r) => !r.ok) });
          return 1;
        }
        request = report.request;
      }
      if (values.inline) request = inlineDocuments(request, html);
      const page = bakeRequest(request, viewerHtml());
      const target = values.out ?? `${request.id}.html`;
      writeFileSync(target, page);
      out({ ok: true, out: target, bytes: page.length, items: request.items.length, inline: request.documents.filter((d) => d.source.kind === 'inline').map((d) => d.id) });
      return 0;
    }
    case 'link': {
      const { request } = requestAt(positionals[0]);
      if (!values.viewer) throw new AnnoquestError('invalid', '`annoquest link` needs --viewer <url> (where the viewer is served).');
      const opts = { reader: values.reader };
      out(values['spec-url'] ? specLink(values['spec-url'], values.viewer, opts) : requestLink(request, values.viewer, opts));
      return 0;
    }
    case 'collect': {
      const { request } = requestAt(values.request);
      const { responses, rejected } = parseResponses(collectInputs(positionals), request);
      const summary = summarize(request, responses);
      if (values.format === 'markdown') out(summaryMarkdown(summary));
      else out({ ...summary, rejected });
      return 0;
    }
    case 'elicit': {
      const { request } = requestAt(positionals[0]);
      const item = request.items.find((i) => i.id === positionals[1]);
      if (!item) throw new AnnoquestError('invalid', `No item "${positionals[1]}". Items: ${request.items.map((i) => i.id).join(', ')}.`);
      out(toElicitation(item, request));
      return 0;
    }
    case 'presets':
      out(presets);
      return 0;
    case 'schema': {
      const which = positionals[0] ?? 'request';
      const schema = which === 'responses' ? Responses : which === 'request' ? Request : null;
      if (!schema) throw new AnnoquestError('invalid', 'schema takes `request` or `responses`.');
      out(z.toJSONSchema(schema, { io: 'input' }));
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP + '\n');
      return 0;
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    const err = e instanceof AnnoquestError ? { code: e.code, message: e.message } : { code: 'internal', message: (e as Error)?.message ?? String(e) };
    process.stderr.write(JSON.stringify({ error: err }) + '\n');
    process.exit(1);
  },
);
