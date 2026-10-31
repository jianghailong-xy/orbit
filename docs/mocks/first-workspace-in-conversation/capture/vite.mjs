import react from '/var/tmp/first-ws-mock/today/node_modules/@vitejs/plugin-react/dist/index.js';

const T = process.env.TREE ?? '/var/tmp/first-ws-mock/today';
export default {
  root: `${T}/src/web`,
  configFile: false,
  cacheDir: `/var/tmp/first-ws-mock/vite-cache-${T.split('/').pop()}`,
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.240'),
  },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: Number(process.env.VPORT ?? 5861), strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
