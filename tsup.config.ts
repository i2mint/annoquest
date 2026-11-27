import { defineConfig } from 'tsup';

// approx-string-match is ESM-only; bundling it (1 KB) keeps the CJS build working.
export default defineConfig([
  {
    // `anchor` is its own entry so a page can take the anchoring core alone (no zod, no linkedom).
    entry: { index: 'src/index.ts', anchor: 'src/anchor.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: false,
    noExternal: ['approx-string-match'],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    platform: 'node',
    clean: false,
    noExternal: ['approx-string-match'],
  },
]);
