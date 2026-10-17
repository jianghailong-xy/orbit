// The session's own tree on vite (:5662), for real-page captures of the Main branch row.
import react from '/root/.orbit/worktrees/afe31010-6ea1-5a82-a79c-06e2e13cda3c/node_modules/@vitejs/plugin-react/dist/index.js';

const T = '/root/.orbit/worktrees/afe31010-6ea1-5a82-a79c-06e2e13cda3c';
export default {
  root: `${T}/src/web`,
  configFile: false,
  cacheDir: '/mnt/data/wmb/kit/vite-cache',
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.229'),
  },
  resolve: { alias: { '@orbit/shared': `${T}/src/shared/src/index.ts` } },
  server: { port: 5662, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
