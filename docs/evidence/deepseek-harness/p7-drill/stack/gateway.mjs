// Loopback-only stand-in for the Compose gateway + web image: serves the built web bundle with the
// SPA fallback and streams /api (REST + SSE) to the apiserver, like gateway/nginx.conf does.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.GW_PORT || 2186);
const API = { host: '127.0.0.1', port: Number(process.env.API_PORT || 3186) };
const ROOT = process.env.WEB_DIST;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
};

function serveFile(res, path) {
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(path).pipe(res);
}

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok\n'); return; }
  if (req.url.startsWith('/api/')) {
    const up = http.request({ ...API, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'http' } }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      res.flushHeaders();
      ur.pipe(res);
    });
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(`gateway: ${e.message}\n`); });
    req.pipe(up);
    res.on('close', () => up.destroy());
    return;
  }
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidate = join(ROOT, rel);
  try {
    if (candidate.startsWith(ROOT) && statSync(candidate).isFile()) { serveFile(res, candidate); return; }
  } catch {}
  serveFile(res, join(ROOT, 'index.html'));
}).listen(PORT, '127.0.0.1', () => console.log(`gateway on http://127.0.0.1:${PORT} -> api ${API.port}, web ${ROOT}`));
