/**
 * A live document: a page that draws its content with JavaScript, opted in with
 * `scripts: true`. Its scripts run, its passages are found once it has drawn them,
 * and found again after it re-renders. Runs the built viewer (dist/viewer.html).
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bakeRequest, createRequest } from '../src/index';

const VIEWER = join(__dirname, '..', 'dist', 'viewer.html');

// Nothing to read until its script runs; window.rerender() redraws it from scratch, as an SPA does on navigation.
const APP = `<!doctype html><html><body><main id="app"></main><script>
window.rerender = (extra) => {
  document.getElementById('app').innerHTML = '<section id="goals"><h2>Goals</h2><p>' + (extra || '') +
    'We will ship the pilot to three sites in two weeks.</p></section>';
};
window.rerender();
</script></body></html>`;

const request = (scripts: boolean) =>
  createRequest({
    id: `live-test-${scripts ? 'on' : 'off'}`,
    title: 'Live document test',
    readers: [{ id: 'sam' }],
    documents: [{ id: 'app', source: { kind: 'url', url: 'app.html', scripts } }],
    items: [{ id: 'ship', prompt: 'Realistic?', priority: 'must', target: { section: 'goals', quote: { exact: 'ship the pilot to three sites' } } }],
  });

const haveViewer = existsSync(VIEWER);
let server: Server;
let base = '';
let browser: Browser;

beforeAll(async () => {
  if (!haveViewer) return;
  const viewer = readFileSync(VIEWER, 'utf8');
  const pages: Record<string, string> = {
    '/on.html': bakeRequest(request(true), viewer),
    '/off.html': bakeRequest(request(false), viewer),
    '/app.html': APP,
  };
  server = createServer((req, res) => {
    const body = pages[(req.url ?? '').split('?')[0]!];
    res.statusCode = body ? 200 : 404;
    res.setHeader('content-type', 'text/html');
    res.end(body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
});

/** Start the guide; return the current passage as the frame's highlight registry holds it. */
async function current(page: Page) {
  return page.evaluate(() => {
    const frameWin = document.querySelector('iframe')!.contentWindow as unknown as { CSS: { highlights: Map<string, Set<Range>> } };
    const r = [...(frameWin.CSS.highlights.get('aq-current') ?? [])][0];
    return r ? { text: r.toString(), connected: r.startContainer.isConnected } : null;
  });
}

async function start(page: Page, path: string) {
  await page.goto(base + path);
  await page.waitForSelector('button.primary', { timeout: 15000 });
  await page.click('button.primary');
  await page.waitForSelector('.card', { timeout: 15000 });
  await page.waitForTimeout(800);
}

describe.skipIf(!haveViewer)('a live document', () => {
  it('runs its scripts, finds its passages, and finds them again after it re-renders', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await start(page, '/on.html');
    expect(await current(page)).toEqual({ text: 'ship the pilot to three sites', connected: true });
    await page.evaluate(() => (document.querySelector('iframe')!.contentWindow as unknown as { rerender: (x: string) => void }).rerender('Revised: '));
    await page.waitForTimeout(800);
    expect(await current(page)).toEqual({ text: 'ship the pilot to three sites', connected: true });
    expect(errors).toEqual([]);
    await page.close();
  }, 60000);

  it('stays script-less unless the request opts in', async () => {
    const page = await browser.newPage();
    await start(page, '/off.html');
    expect(await page.evaluate(() => document.querySelector('iframe')!.contentDocument!.getElementById('goals'))).toBeNull();
    expect(await current(page)).toBeNull();
    await page.close();
  }, 60000);
});
