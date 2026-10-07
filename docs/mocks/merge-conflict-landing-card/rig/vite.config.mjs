import react from '/root/orbit/node_modules/@vitejs/plugin-react/dist/index.js'; // point at any install that has @vitejs/plugin-react

const WT = process.env.WT ?? '/root/orbit'; // the checkout whose src/web is rendered
export default {
  root: `${WT}/src/web`,
  configFile: false,
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify('http://localhost:2086'),
    __APP_VERSION__: JSON.stringify('0.1.215'),
  },
  resolve: { alias: { '@orbit/shared': `${WT}/src/shared/src/index.ts` } },
  server: {
    port: 5197,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:3997', changeOrigin: true } },
  },
};
