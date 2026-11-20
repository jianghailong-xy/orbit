import react from '/var/tmp/coord-fold-mock/today/node_modules/@vitejs/plugin-react/dist/index.js';
const T = '/var/tmp/fold-rule-mock/proto';
export default {
  root: `${T}/src/web`, configFile: false, cacheDir: '/var/tmp/fold-rule-mock/vite-cache', plugins: [react()],
  define: { __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'), __APP_VERSION__: JSON.stringify('0.1.253') },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: 5881, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
