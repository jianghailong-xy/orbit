/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The repo version (the one `chore: bump to X` moves), not this package's own — src/web/package.json
// carries a placeholder 0.1.0 that has never tracked a release. Reported on every request as
// `X-Orbit-Client`, so what a stale tab answers with has to be the number releases are cut against.
const APP_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
).version as string;

// React Router 7 ships a development and a production build, but its exports map has no
// `production` condition: `.` and `./dom` both resolve to `dist/development`, so a plain Vite build
// puts the development build in the shipped bundle. That build has `ENABLE_DEV_WARNINGS = true`,
// which is how warnings like "Matched leaf route ... does not have an element" end up in a
// production console, and it carries the checks behind them. Point both public entry points at the
// production files, located through the installed package so hoisting decides where it is. The two
// entries share their chunks, so aliasing both keeps one router — and one Router context.
const routerProduction = (entry: string) =>
  join(
    dirname(createRequire(import.meta.url).resolve('react-router/package.json')),
    'dist',
    'production',
    entry,
  );

// Dev proxies /api (REST + SSE) to the control plane, so the browser stays same-origin.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Public origin shown in the "Add a runner" install commands. Baked in at build time
  // from PUBLIC_ORIGIN (the web image's build arg, sourced from .env); falls back to the
  // local gateway when unset. Build-time so the static image carries no runtime config.
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify(process.env.PUBLIC_ORIGIN || 'http://localhost:2086'),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: [
      {
        // Consume the shared workspace package from source so Vite compiles its TS
        // directly — avoids rollup failing to trace named exports through its
        // compiled CJS (`__exportStar`).
        find: /^@orbit\/shared$/,
        replacement: fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      },
      // The build is the artifact that ships. The dev server and tests keep the development build,
      // whose warnings are useful where someone can act on them.
      ...(command === 'build'
        ? [
            { find: /^react-router$/, replacement: routerProduction('index.mjs') },
            { find: /^react-router\/dom$/, replacement: routerProduction('dom-export.mjs') },
          ]
        : []),
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  // The first page gets ONE stylesheet: every CSS module the entry imports statically, in the order the
  // modules are first imported (main.tsx's own list, then each Orbit component's CSS where the app first
  // imports the component). Left to automatic chunking, a component the entry shares with a lazy chunk (the
  // dependency graphs, the session export) moves into a shared chunk, and a shared chunk's stylesheet is
  // linked ahead of the entry's — index.css included — so a page rule then wins a same-weight tie with that
  // component that it loses everywhere else. CSS only lazy chunks import (React Flow's) stays with them.
  // Held by src/firstPageStylesheet.test.ts.
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: 'app', test: /\.css$/, tags: ['$initial'] }] },
      },
    },
  },
  // `<Transcript>` alone takes seconds to mount on a loaded host — 7.8s for the first mount, measured
  // with a swift build running beside it — so vitest's 5s default reds its specs on wall clock alone,
  // and a red gets read as a regression in whatever was just changed. 30s is the headroom those specs
  // were already asking for one file at a time (`{ timeout: 30_000 }`); a hung test still fails, later.
  //
  // The budget lives here and not in the files: a `{ timeout: n }` written on a describe/it REPLACES
  // this one, and `--testTimeout` cannot raise it. A file-local number below 30s therefore reds on a
  // loaded host with no flag that can help, and one at 30s is a ceiling nobody can retune either.
  test: {
    testTimeout: 30_000,
  },
}));
