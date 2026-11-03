// This worktree's own web app on :5871, for the zero-commit landing board (capture.mjs).
const W = '/root/.orbit/worktrees/1c275d44-d415-5572-8505-0da4e243125e';
const { default: react } = await import(`${W}/node_modules/@vitejs/plugin-react/dist/index.js`);
export default {
  root: `${W}/src/web`,
  configFile: false,
  cacheDir: '/var/tmp/zero-commit-mock/vite-cache',
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('https://orbit.example.com'),
    __APP_VERSION__: JSON.stringify('0.1.0'),
  },
  resolve: { alias: { '@orbit/shared': `${W}/src/shared/src/index.ts` } },
  server: { port: 5871, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
};
