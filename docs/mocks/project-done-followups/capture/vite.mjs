import react from '/root/.orbit/worktrees/67abea98-cec7-5593-80f0-8a0ef57346a7/node_modules/@vitejs/plugin-react/dist/index.js';
const T = '/root/.orbit/worktrees/67abea98-cec7-5593-80f0-8a0ef57346a7';
export default {
  root: `${T}/src/web`, configFile: false, cacheDir: '/mnt/data/tmp/pdf-mock/vite-cache', plugins: [react()],
  define: { __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'), __APP_VERSION__: JSON.stringify('0.1.254') },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: 5941, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
