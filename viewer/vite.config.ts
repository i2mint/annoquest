// The viewer builds to one self-contained file (dist/viewer.html): `annoquest bake`
// injects a request into it, and the server adapter serves it as is.
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: resolve(__dirname),
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve(__dirname, '..', 'dist', 'viewer'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
