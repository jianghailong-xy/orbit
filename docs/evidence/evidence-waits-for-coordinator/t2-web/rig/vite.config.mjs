// The worktree's own web app on :5761, for the T2 evidence captures (capture.mjs).
import react from '/root/.orbit/worktrees/57f90b1f-7a0a-5f57-bf91-d3483f1f4637/node_modules/@vitejs/plugin-react/dist/index.js';

const W = '/root/.orbit/worktrees/57f90b1f-7a0a-5f57-bf91-d3483f1f4637';
export default {
  root: `${W}/src/web`,
  configFile: false,
  cacheDir: '/mnt/data/t2-web-shots/vite-cache',
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.0'),
  },
  resolve: { alias: { '@orbit/shared': `${W}/src/shared/src/index.ts` } },
  server: { port: 5761, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
