# annoquest — dev notes

Seams (see docs/design.md): document source (inline | url), delivery (baked | #r= | ?spec=), device store (zodal DataProvider, localStorage), sink (local | http), identity (self-declared | server header). Surfaces built: library, CLI, viewer, shipped skill, Python server adapter. Not built: MCP server, encrypted relay sink.

- The Zod schema in `src/spec.ts` is the SSOT; the CLI's `schema` command and the viewer derive from it.
- Gate: `pnpm typecheck && pnpm build && pnpm test && pnpm smoke`, and `uv venv && uv pip install -e ".[test]" && .venv/bin/pytest -q`.
- The viewer is one file (`dist/viewer.html`, vite-plugin-singlefile); its frame is sandboxed without scripts, and the parent drives the DOM.
- Public repo: no private names, hostnames or document content in code, docs, tests or commits.
