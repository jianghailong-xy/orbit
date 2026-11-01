import react from '/root/.orbit/worktrees/ea00e920-f8d6-543a-a3ad-d78cee336a8f/node_modules/@vitejs/plugin-react/dist/index.js';

const T = process.env.TREE;
export default {
  root: `${T}/src/web`,
  configFile: false,
  cacheDir: `/mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit/vite-cache-${T.split('/').filter(Boolean).join('_')}`,
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.240'),
  },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: Number(process.env.VPORT ?? 5797), strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
