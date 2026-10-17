// node serve-web.mjs <checkout> <web root> <port> <api port> <cache dir> — vite dev of a src/web tree (this
// checkout's, or the old client's archived copy), with the checkout's vite and React plugin (same lockfile), the
// tree's own @orbit/shared source, and /api proxied to the stack's apiserver. Mirrors src/web/vite.config.ts
// apart from the port and the proxy target, which that file fixes at 5173 and localhost:3000.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [checkout, root, port, apiPort, cacheDir] = process.argv.slice(2);
const { createServer } = await import(`${checkout}/node_modules/vite/dist/node/index.js`);
const react = (await import(`${checkout}/node_modules/@vitejs/plugin-react/dist/index.js`)).default;
const version = JSON.parse(readFileSync(join(root, '..', '..', 'package.json'), 'utf8')).version;
const server = await createServer({
  root,
  configFile: false,
  cacheDir,
  plugins: [react()],
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify(`http://127.0.0.1:${port}`),
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: { alias: { '@orbit/shared': join(dirname(root), 'shared', 'src', 'index.ts') } },
  server: {
    port: Number(port),
    strictPort: true,
    host: '127.0.0.1',
    fs: { strict: false },
    hmr: false,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
});
await server.listen();
server.printUrls();
