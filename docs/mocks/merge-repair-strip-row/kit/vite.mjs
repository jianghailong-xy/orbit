import react from '/root/.orbit/worktrees/01a1d8e5-23c8-761d-ad9c-9170694723ee/node_modules/@vitejs/plugin-react/dist/index.js';
const T = '/root/.orbit/worktrees/01a1d8e5-23c8-761d-ad9c-9170694723ee';
export default {
  root: `${T}/src/web`, configFile: false, cacheDir: '/var/tmp/rpr-mock/vite-cache', plugins: [react()],
  define: { __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'), __APP_VERSION__: JSON.stringify('0.1.260') },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: 5811, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
