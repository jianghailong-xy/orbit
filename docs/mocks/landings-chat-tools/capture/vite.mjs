import react from '/root/.orbit/worktrees/01a1c548-51fd-7597-8625-78f9a70996c3/node_modules/@vitejs/plugin-react/dist/index.js';
const T = '/root/.orbit/worktrees/01a1c548-51fd-7597-8625-78f9a70996c3';
export default {
  root: `${T}/src/web`, configFile: false, cacheDir: '/mnt/data/tmp/landings-chat3/vite-cache', plugins: [react()],
  define: { __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'), __APP_VERSION__: JSON.stringify('0.1.260') },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: 5893, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
