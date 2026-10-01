# stslv-web

Web application for STSLV AMC (React, TypeScript, Vite, Tailwind CSS).

```
npm run dev         # development server on http://localhost:5173 (needs the API on port 3001)
npm test            # component and workflow tests
npm run typecheck   # TypeScript check
npm run lint        # oxlint
npm run build       # type check and production build into dist/
```

The development server forwards `/api/*` to `http://localhost:3001`. Set `VITE_API_PROXY_TARGET` to point it at a different API address.

Project guardrails are in `../CLAUDE.md`; the foundation is described in `../docs/FOUNDATION.md`.
