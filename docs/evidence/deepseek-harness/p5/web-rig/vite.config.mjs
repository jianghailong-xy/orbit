import react from '/root/.orbit/worktrees/b3f256ba-39da-5ffe-8364-77c2cef31f4f/node_modules/@vitejs/plugin-react/dist/index.js';

const WT = '/root/.orbit/worktrees/b3f256ba-39da-5ffe-8364-77c2cef31f4f';
export default {
  root: `${WT}/src/web`,
  configFile: false,
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('http://localhost:2086'),
    __APP_VERSION__: JSON.stringify('p5-evidence'),
  },
  resolve: { alias: { '@orbit/shared': `${WT}/src/shared/src/index.ts` } },
  server: {
    port: 5195,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:3995', changeOrigin: true } },
  },
};
