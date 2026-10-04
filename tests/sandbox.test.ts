/**
 * A baked page, opened the ways it is really opened: on its own, and inside a host that
 * sandboxes it without allow-same-origin (a document tray, a mail client's preview).
 * Runs the built viewer (dist/viewer.html) in a real browser.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit, type Browser, type BrowserType, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bakeRequest, createRequest, inlineDocuments } from '../src/index';

const VIEWER = join(__dirname, '..', 'dist', 'viewer.html');
// The sandbox a document host applies, as an attribute on its frame and as a CSP on the page.
const SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals allow-downloads';

const DOC = `<!doctype html><html><head><style>body { font-family: serif } .x { color: red }</style>
<script>document.documentElement.dataset.scripted = 'yes'</script></head><body id="top">
<section id="goals"><h2>Goals</h2><p>We will ship the pilot to three sites in two weeks.</p>
<img src="x" onerror="window.pwned = 'onerror'"><a id="bad" href="javascript:window.pwned='href'">bad link</a>
<a id="jump" href="#later">jump</a> <a id="ext" href="https://example.org/">ext</a></section>
<section id="hostile"><h2>Hostile</h2>
<svg width="60" height="20"><a id="svga" href="jav&#x09;ascript:window.pwned='svg-a'"><text x="0" y="15">svg</text></a></svg>
<svg width="60" height="20"><a id="xl" xlink:href="javascript:window.pwned='xlink'"><text x="0" y="15">xlink</text></a></svg>
<svg width="60" height="20"><a id="anim"><set attributeName="href" to="javascript:window.pwned='set'"/><text x="0" y="15">anim</text></a></svg>
<form><button id="fb" formaction="jav&#x0A;ascript:window.pwned='formaction'">go</button></form>
<a id="ctrl" href="&#x01;javascript:window.pwned='ctrl'">ctrl</a>
<img usemap="#m" width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><map name="m"><area id="area" shape="rect" coords="0,0,10,10" href="jav&#x09;ascript:window.pwned='area'"></map>
<div id="overlay" style="position:fixed;inset:0;z-index:2147483647;background:rgba(255,0,0,.02)">overlay</div>
</section>
<details id="later"><summary>Later</summary><p>The budget is fixed at 10k, no more.</p></details>
</body></html>`;

const request = inlineDocuments(
  createRequest({
    id: 'sandbox-test-0001',
    title: 'Sandbox test',
    readers: [{ id: 'sam' }],
    // Two documents: on a shared highlight registry, the second must not repaint over the first.
    documents: [
      { id: 'd', source: { kind: 'url', url: 'doc.html' } },
      { id: 'notes', source: { kind: 'url', url: 'notes.html' } },
    ],
    items: [
      { id: 'ship', prompt: 'Realistic?', priority: 'must', target: { section: 'goals', quote: { exact: 'ship the pilot to three sites' } } },
      { id: 'budget', prompt: 'OK?', priority: 'should', response: 'approve', target: { section: 'later', quote: { exact: 'fixed at 10k' } } },
      { id: 'notes', prompt: 'Read these notes.', priority: 'could', response: 'read', doc: 'notes', target: { quote: { exact: 'nothing else to add' } } },
    ],
  }),
  { d: DOC, notes: '<!doctype html><body><p>There is nothing else to add.</p></body>' },
);

const haveViewer = existsSync(VIEWER);
let server: Server;
let base = '';
const browsers = new Map<string, Browser>();
// Chromium always; WebKit (Safari's engine, what a phone uses) when its browser is installed.
const ENGINES: Array<[string, BrowserType]> = [['chromium', chromium], ...(existsSync(webkit.executablePath()) ? [['webkit', webkit] as [string, BrowserType]] : [])];

beforeAll(async () => {
  if (!haveViewer) return;
  const page = bakeRequest(request, readFileSync(VIEWER, 'utf8'));
  server = createServer((req, res) => {
    if (req.url?.startsWith('/host.html')) {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><iframe id="f" src="/page.html" sandbox="${SANDBOX}" style="width:800px;height:700px"></iframe>`);
    } else if (req.url?.startsWith('/page.html')) {
      res.setHeader('content-type', 'text/html');
      if (req.url.includes('sandboxed')) res.setHeader('content-security-policy', `sandbox ${SANDBOX}`);
      res.end(page);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  for (const [name, type] of ENGINES) browsers.set(name, await type.launch());
}, 60000);

afterAll(async () => {
  for (const b of browsers.values()) await b.close();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
});

/** Start the guide and report what the reader would see for the current item. */
async function startAndInspect(frame: Frame) {
  await frame.waitForSelector('button.primary', { timeout: 15000 });
  await frame.evaluate(() => (document.querySelector('button.primary') as HTMLButtonElement).click());
  await frame.waitForSelector('.card', { timeout: 15000 });
  await frame.waitForTimeout(800);
  return frame.evaluate(() => {
    const reg = (window as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights;
    const named = (base: string) => [...reg.keys()].filter((k) => k === base || k.startsWith(base + '-')).flatMap((k) => [...reg.get(k)!]);
    const current = named('aq-current');
    const others = named('aq-item');
    const frameDoc = document.querySelector('iframe')?.contentDocument;
    const hl = frameDoc ? (frameDoc.defaultView as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights : null;
    return {
      detached: !!document.querySelector('.doc-detached'),
      shadow: !!document.querySelector('.doc-shadow'),
      current: (current[0] ?? (hl ? [...(hl.get('aq-current') ?? [])][0] : undefined))?.toString(),
      others: others.length || (hl ? [...(hl.get('aq-item') ?? [])].length : 0),
      scripted: document.documentElement.dataset.scripted ?? frameDoc?.documentElement.dataset.scripted ?? null,
      pwned: (window as unknown as { pwned?: string }).pwned ?? null,
    };
  });
}

describe.skipIf(!haveViewer).each(ENGINES.map(([n]) => n))('a baked page in %s', (engine) => {
  const browser = { newPage: () => browsers.get(engine)!.newPage() };
  it('highlights in its frame when opened directly', async () => {
    const page: Page = await browser.newPage();
    await page.goto(`${base}/page.html`);
    const seen = await startAndInspect(page.mainFrame());
    expect(seen).toMatchObject({ detached: false, shadow: false, current: 'ship the pilot to three sites', others: 1, scripted: null, pwned: null });
    // A link followed in the framed snapshot opens elsewhere; the document never leaves its frame,
    // and on a normal origin it is never moved into this page's DOM.
    const popup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    await page.evaluate(() => (document.querySelector('iframe')!.contentDocument!.getElementById('ext') as HTMLAnchorElement).click());
    await (await popup)?.close();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => ({ shadow: !!document.querySelector('.doc-shadow'), reachable: !!document.querySelector('iframe')?.contentDocument?.getElementById('goals') }))).toEqual({ shadow: false, reachable: true });
    await page.close();
  }, 60000);

  it('keeps highlighting and navigation inside a sandbox without allow-same-origin', async () => {
    const page: Page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/host.html?sandboxed`);
    // The framed page gets the CSP sandbox too when its URL says so; the host's attribute applies either way.
    await page.evaluate(() => ((document.getElementById('f') as HTMLIFrameElement).src = '/page.html?sandboxed'));
    await page.waitForTimeout(500);
    const frame = page.frames().find((f) => f.url().includes('page.html'))!;
    expect(await frame.evaluate(() => self.origin)).toBe('null');
    const seen = await startAndInspect(frame);
    // others: one passage in each document, both still painted (a shared registry must not lose one).
    expect(seen).toMatchObject({ detached: false, shadow: true, current: 'ship the pilot to three sites', others: 2, scripted: null, pwned: null });
    // The document scrolls inside its pane: the page never grows to the document's height
    // (a 47,000 px tall panel painted blank in Chrome).
    const fit = await frame.evaluate(() => {
      // Make the document taller than the frame, as a real one is.
      document.querySelector('.doc-shadow > div')!.shadowRoot!.querySelector('.aq-body')!.insertAdjacentHTML('beforeend', '<p>filler</p>'.repeat(400));
      const pane = document.querySelector('.doc-shadow')!;
      return { panel: document.querySelector('.panel')!.getBoundingClientRect().height, pane: pane.getBoundingClientRect().height, view: innerHeight, scrolls: pane.scrollHeight > pane.clientHeight };
    });
    expect(fit.panel).toBeLessThanOrEqual(fit.view);
    expect(fit.pane).toBeLessThanOrEqual(fit.view);
    expect(fit.scrolls).toBe(true);

    // Navigating to the other item opens its <details> and highlights inside it.
    await frame.evaluate(() => [...document.querySelectorAll('.row-btn')].find((b) => b.textContent!.includes('OK?'))!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await frame.waitForTimeout(800);
    const second = await frame.evaluate(() => {
      const host = document.querySelector('.doc-shadow > div')!;
      const details = host.shadowRoot!.getElementById('later') as HTMLDetailsElement;
      const reg = (window as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights;
      const cur = [...reg.keys()].filter((k) => k.startsWith('aq-current')).flatMap((k) => [...reg.get(k)!]);
      return { open: details.open, current: cur[0]?.toString(), url: location.href };
    });
    expect(second).toMatchObject({ open: true, current: 'fixed at 10k' });

    // An in-document link scrolls inside the document instead of rewriting the viewer's URL.
    await frame.evaluate(() => (document.querySelector('.doc-shadow > div')!.shadowRoot!.getElementById('jump') as HTMLAnchorElement).click());
    expect(await frame.evaluate(() => location.hash)).toBe('');
    // The unsafe link and handler were stripped.
    expect(await frame.evaluate(() => document.querySelector('.doc-shadow > div')!.shadowRoot!.getElementById('bad')!.getAttribute('href'))).toBeNull();
    expect(errors).toEqual([]);
    await page.close();
  }, 60000);

  it('runs nothing from a hostile document, and lets nothing cover the guide', async () => {
    const page: Page = await browser.newPage();
    await page.goto(`${base}/host.html?sandboxed`);
    await page.evaluate(() => ((document.getElementById('f') as HTMLIFrameElement).src = '/page.html?sandboxed'));
    await page.waitForTimeout(500);
    const frame = page.frames().find((f) => f.url().includes('page.html'))!;
    await startAndInspect(frame);
    const before = await frame.evaluate(() => location.href);
    const result = await frame.evaluate(async () => {
      const sh = document.querySelector('.doc-shadow > div')!.shadowRoot!;
      const click = (id: string) => sh.getElementById(id)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      for (const id of ['svga', 'xl', 'anim', 'fb', 'ctrl', 'area']) click(id);
      (sh.getElementById('ctrl') as HTMLAnchorElement | null)?.click();
      (sh.getElementById('fb') as HTMLButtonElement | null)?.click();
      await new Promise((r) => setTimeout(r, 600));
      const panel = document.querySelector('.panel')!.getBoundingClientRect();
      const topEl = document.elementFromPoint(panel.left + panel.width / 2, panel.top + panel.height / 2);
      const attrs = ['svga', 'xl', 'ctrl', 'area'].map((id) => [id, sh.getElementById(id)?.getAttribute('href') ?? sh.getElementById(id)?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? null]);
      return {
        pwned: (window as unknown as { pwned?: string }).pwned ?? null,
        overlayCoversGuide: !document.querySelector('.panel')!.contains(topEl),
        forms: sh.querySelectorAll('form, button, set').length,
        attrs,
      };
    });
    expect(result.pwned).toBeNull();
    expect(result.overlayCoversGuide).toBe(false);
    expect(result.forms).toBe(0);
    for (const [, href] of result.attrs) expect(href).toBeNull();
    expect(await frame.evaluate(() => location.href)).toBe(before);
    await page.close();
  }, 60000);
});
