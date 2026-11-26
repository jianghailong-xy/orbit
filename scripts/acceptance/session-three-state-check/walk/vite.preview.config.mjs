// `vite preview` of a tip checkout's built console (src/web/dist), proxying /api (REST, SSE and WebSocket) to the
// walk's apiserver. Kept outside the checkout so the repo's own vite.config.ts (proxy fixed to :3000) is untouched.
// usage: WALK_WEB_ROOT=<tip>/src/web WALK_API=http://127.0.0.1:<port> WALK_WEB_PORT=<port> \
//        npx vite preview --config vite.preview.config.mjs
const root = process.env.WALK_WEB_ROOT;
const target = process.env.WALK_API;
const port = Number(process.env.WALK_WEB_PORT);
if (!root || !target || !port) throw new Error('WALK_WEB_ROOT, WALK_API and WALK_WEB_PORT are required');

export default {
  root,
  configFile: false,
  build: { outDir: 'dist' },
  preview: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: { '/api': { target, changeOrigin: true, ws: true } },
  },
};
