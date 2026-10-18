// The P7a worktree's own src/web + src/shared on vite, for the real-page captures.
import react from '/root/.orbit/worktrees/78464a5d-24b1-57a8-974b-5e0d92096ee3/node_modules/@vitejs/plugin-react/dist/index.js';

const T = process.env.TREE ?? '/root/.orbit/worktrees/78464a5d-24b1-57a8-974b-5e0d92096ee3';
export default {
  root: `${T}/src/web`,
  configFile: false,
  cacheDir: '/mnt/data/tmp/p7a-variants-shots/vite-cache',
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.262'),
  },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: Number(process.env.VPORT ?? 5791), strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
