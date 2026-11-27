// The real web app of this tree on vite, for the captures (run.sh).
import react from '/root/.orbit/worktrees/d672e756-e8ec-5391-a44c-bfc54dcb732c/node_modules/@vitejs/plugin-react/dist/index.js';

const T = process.env.TREE ?? '/root/.orbit/worktrees/d672e756-e8ec-5391-a44c-bfc54dcb732c';
export default {
  root: `${T}/src/web`,
  configFile: false,
  cacheDir: '/var/tmp/session-phase-mock/vite-cache',
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.261'),
  },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: Number(process.env.VPORT ?? 5798), strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
