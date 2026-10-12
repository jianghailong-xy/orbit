// Loopback-only stand-in for the Compose gateway + web image: serves the built web bundle with the SPA
// fallback and streams /api (REST + SSE) to the apiserver, setting X-Real-IP to the connecting address as
// gateway/nginx.conf does. Listens on 127.0.0.1 and ::1 so that http://localhost:2386 works either way.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const PORT = 2386;
const API = { host: '127.0.0.1', port: 3386 };
const ROOT = '/var/tmp/google-sign-in-admin-hints/src/src/web/dist';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.sh': 'text/plain',
};
const serveFile = (res, path) => {
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(path).pipe(res);
};
const handler = (req, res) => {
  if (req.url === '/healthz') { res.end('ok\n'); return; }
  if (req.url.startsWith('/api/')) {
    const addr = req.socket.remoteAddress;
    const up = http.request({ ...API, path: req.url, method: req.method,
      headers: { ...req.headers, 'x-real-ip': addr, 'x-forwarded-for': addr, 'x-forwarded-proto': 'http' } }, (ur) => {
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
};
for (const host of ['127.0.0.1', '::1']) {
  http.createServer(handler).listen(PORT, host, () => console.log(`gateway on http://[${host}]:${PORT} -> api ${API.port}, web ${ROOT}`));
}
