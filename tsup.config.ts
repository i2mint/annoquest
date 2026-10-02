import { defineConfig } from 'tsup';

// approx-string-match is ESM-only; bundling it (1 KB) keeps the CJS build working.
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
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
