import react from '/mnt/data/tmp/runner-res-mock/tree/node_modules/@vitejs/plugin-react/dist/index.js';

const T = process.env.TREE ?? '/mnt/data/tmp/runner-res-mock/tree';
export default {
  root: `${T}/src/web`,
  configFile: false,
  cacheDir: `/mnt/data/tmp/runner-res-mock/vite-cache-${T.split('/').pop()}`,
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.240'),
  },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: Number(process.env.VPORT ?? 5874), strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
