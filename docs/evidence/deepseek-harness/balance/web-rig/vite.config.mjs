// The web console of THIS checkout (src/web), served by vite with /api proxied to server.mjs. Run from
// src/web:  ../../node_modules/.bin/vite --config <this file>
import { fileURLToPath } from 'node:url';

const CHECKOUT = fileURLToPath(new URL('../../../../../', import.meta.url));
const { default: react } = await import(`${CHECKOUT}node_modules/@vitejs/plugin-react/dist/index.js`);

export default {
  root: `${CHECKOUT}src/web`,
  configFile: false,
  plugins: [react()],
  cacheDir: '/var/tmp/ds-balance-vite-cache',
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('http://localhost:2086'),
    __APP_VERSION__: JSON.stringify('0.1.215'),
  },
  resolve: { alias: { '@orbit/shared': `${CHECKOUT}src/shared/src/index.ts` } },
  server: {
    port: Number(process.env.VITE_PORT ?? 5193),
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 3993}`, changeOrigin: true } },
  },
};
