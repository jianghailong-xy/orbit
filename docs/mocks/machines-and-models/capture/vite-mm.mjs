import react from '/var/tmp/infra-focus-mock/mm-today/node_modules/@vitejs/plugin-react/dist/index.js';

const T = process.env.TREE ?? '/var/tmp/infra-focus-mock/mm-today';
export default {
  root: `${T}/src/web`,
  configFile: false,
  cacheDir: `/var/tmp/infra-focus-mock/vite-cache-mm-${T.split('/').pop()}`,
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.236'),
  },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: Number(process.env.VPORT ?? 5793), strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
