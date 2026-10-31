// The web console for the e2e stack, the way production's gateway serves it: DIST's static files with an SPA
// fallback, and /api passed through to the apiserver unbuffered (the console's event streams are SSE). Loopback only.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const WEB_PORT = Number(process.env.WEB_PORT);
const API_PORT = Number(process.env.API_PORT);
const DIST = process.env.DIST;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.txt': 'text/plain',
};

http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/') || url === '/api') {
    const upstream = http.request({
      host: '127.0.0.1', port: API_PORT, method: req.method, path: url,
      headers: { ...req.headers, 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' },
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`gateway: ${e.message}`);
    });
    req.pipe(upstream);
    res.on('close', () => upstream.destroy());
    return;
  }
  const pathname = decodeURIComponent(url.split('?')[0]);
  let file = normalize(join(DIST, pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(WEB_PORT, '127.0.0.1', () => console.log(`web http://127.0.0.1:${WEB_PORT} (dist ${DIST}) -> api :${API_PORT}`));
