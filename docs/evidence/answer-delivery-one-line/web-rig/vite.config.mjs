// This worktree's own web app on :5763, for the answer-delivery-one-line evidence captures (capture.mjs).
import react from '/root/.orbit/worktrees/eb1d9354-6df5-55cf-a6cc-28e45786a362/node_modules/@vitejs/plugin-react/dist/index.js';

const W = '/root/.orbit/worktrees/eb1d9354-6df5-55cf-a6cc-28e45786a362';
export default {
  root: `${W}/src/web`,
  configFile: false,
  cacheDir: '/mnt/data/eb1d-web-shots/vite-cache',
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.0'),
  },
  resolve: { alias: { '@orbit/shared': `${W}/src/shared/src/index.ts` } },
  server: { port: 5763, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
