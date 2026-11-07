// Serves a built web console with SPA fallback and streams /api to the apiserver (SSE included).
// usage: node gateway.mjs <dist> <listen-port> <api-port> [host]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const [dist, port, apiPort, host = '0.0.0.0'] = process.argv.slice(2);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain', '.wasm': 'application/wasm', '.map': 'application/json' };
http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/api') {
    const up = http.request({ host: '127.0.0.1', port: Number(apiPort), path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${apiPort}`, 'x-real-ip': req.socket.remoteAddress ?? '127.0.0.1' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
    return;
  }
  const clean = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(dist, clean);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(Number(port), host, () => console.log(`gateway ${host}:${port} -> dist ${dist}, api :${apiPort}`));
