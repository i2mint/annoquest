import { existsSync, readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import * as anchor from '../src/anchor';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { exports: Record<string, { import: unknown; require: unknown }> };

/** `annoquest/anchor` is the anchoring core alone, for a page that wants nothing else. */
describe('the anchor subpath', () => {
  it('is declared for import and require, with types', () => {
    const entry = pkg.exports['./anchor']!;
    expect(entry.import).toEqual({ types: './dist/anchor.d.ts', default: './dist/anchor.js' });
    expect(entry.require).toEqual({ types: './dist/anchor.d.cts', default: './dist/anchor.cjs' });
  });

  it('exports what a host needs to describe a selection and find it again', () => {
    for (const name of ['normalizeText', 'indexText', 'findQuote', 'matchToRange', 'positionOf', 'describeQuote', 'occurrenceOf']) {
      expect(typeof (anchor as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('leaves out the elements a caller asks to skip, so an overlay inside the root is never matched', () => {
    const { document } = parseHTML('<main><p>Kept text here.</p><aside class="overlay"><p>Kept text, quoted in a card.</p></aside></main>');
    const root = document.querySelector('main')!;
    expect(anchor.indexText(root).text).toContain('quoted in a card');
    const index = anchor.indexText(root, { skip: (el) => el.classList.contains('overlay') });
    expect(index.text.trim()).toBe('Kept text here.'); // a block boundary reads as a space
    expect(anchor.findQuote(index, { exact: 'quoted in a card' }).ok).toBe(false);
  });

  // The build runs before the tests in CI; a checkout that has not been built skips this.
  it.skipIf(!existsSync('dist/anchor.js'))('pulls in no schema, zip or DOM library when built', () => {
    for (const entry of ['dist/anchor.js', 'dist/anchor.cjs']) {
      // The entry and every local chunk it loads: only relative imports, none of the heavy ones.
      const seen = new Set<string>();
      const queue = [entry];
      while (queue.length) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const built = readFileSync(file, 'utf8');
        for (const m of built.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)) {
          const spec = m[1]!;
          expect(spec.startsWith('.'), `${file} loads ${spec}`).toBe(true);
          queue.push(new URL(spec, new URL(file, 'file:///')).pathname.slice(1));
        }
      }
    }
  });
});
