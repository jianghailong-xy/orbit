import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The repo version (the one `chore: bump to X` moves), not this package's own — src/web/package.json
// carries a placeholder 0.1.0 that has never tracked a release. Reported on every request as
// `X-Orbit-Client`, so what a stale tab answers with has to be the number releases are cut against.
const APP_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
).version as string;

// Dev proxies /api (REST + SSE) to the control plane, so the browser stays same-origin.
export default defineConfig({
  plugins: [react()],
  // Public origin shown in the "Add a runner" install commands. Baked in at build time
  // from PUBLIC_ORIGIN (the web image's build arg, sourced from .env); falls back to the
  // local gateway when unset. Build-time so the static image carries no runtime config.
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify(process.env.PUBLIC_ORIGIN || 'http://localhost:2086'),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      // Consume the shared workspace package from source so Vite compiles its TS
      // directly — avoids rollup failing to trace named exports through its
      // compiled CJS (`__exportStar`).
      '@orbit/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
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
});
