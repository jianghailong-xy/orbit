// mb-e2e (task 34cjZaHv0mgIv11c7HWr3), reused by T07: serve one web build (dist) on 127.0.0.1:<port> and pass /api
// (REST and SSE) through to one stack's apiserver, so the browser stays same-origin as it does behind the
// production gateway.
// usage: node serve-web.mjs <distDir> <port> <apiPort>
// T07_NO_CAPABILITIES=1 answers GET /api/auth/capabilities 404 as a server from before the route does (Nest's
// own 404), and passes everything else through: the "capability missing" case on a real server.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const [, , distArg, portArg, apiPortArg] = process.argv;
const dist = path.resolve(distArg);
const port = Number(portArg);
const apiPort = Number(apiPortArg);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  if (process.env.T07_NO_CAPABILITIES === '1' && new URL(req.url, 'http://x').pathname === '/api/auth/capabilities') {
    const body = JSON.stringify({ message: 'Cannot GET /api/auth/capabilities', error: 'Not Found', statusCode: 404 });
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/dl/')) {
    const headers = { ...req.headers, host: `127.0.0.1:${apiPort}` };
    // The apiserver's CORS list names its own origin: a same-origin page behind a gateway looks like that.
    if (headers.origin) headers.origin = `http://127.0.0.1:${apiPort}`;
    const upstream = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy: ${e.message}`);
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
    return;
  }
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(dist, pathname);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(port, '127.0.0.1', () => console.log(`web ${dist} on http://127.0.0.1:${port} -> api 127.0.0.1:${apiPort}`));
