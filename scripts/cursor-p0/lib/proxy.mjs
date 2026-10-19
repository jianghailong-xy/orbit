// A logging HTTP(S) proxy: every CONNECT tunnel (host, port, bytes each way, open/close time)
// is recorded, so a scenario can list the hosts the CLI talks to and how much it uploads.
// `deny(host)` returning true refuses the tunnel with 403 (a host the experiment blocks).
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

export function startProxy({ deny = () => false } = {}) {
  let cut = false;
  const denied = host => cut || deny(host);
  const tunnels = [];
  const sockets = new Set();
  const t0 = Date.now();
  const server = createServer((req, res) => {
    // Plain-HTTP proxying (absolute-URI requests): logged, forwarded unless denied.
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    const entry = { kind: 'http', host: url.hostname, port: Number(url.port || 80), method: req.method, path: url.pathname,
      openedMs: Date.now() - t0, up: 0, down: 0, denied: denied(url.hostname) };
    tunnels.push(entry);
    if (entry.denied) { res.writeHead(403).end(); return; }
    const up = httpRequest({ host: url.hostname, port: entry.port, method: req.method, path: url.pathname + url.search, headers: req.headers }, r => {
      res.writeHead(r.statusCode, r.headers);
      r.on('data', d => { entry.down += d.length; });
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.on('data', d => { entry.up += d.length; });
    req.pipe(up);
  });
  server.on('connect', (req, socket, head) => {
    const [host, portText] = req.url.split(':');
    const entry = { kind: 'connect', host, port: Number(portText || 443), openedMs: Date.now() - t0, up: head.length, down: 0, denied: denied(host) };
    tunnels.push(entry);
    sockets.add(socket);
    socket.on('error', () => {});
    if (entry.denied) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      entry.closedMs = Date.now() - t0;
      return;
    }
    const upstream = connect(entry.port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.on('data', d => { entry.up += d.length; upstream.write(d); });
      upstream.on('data', d => { entry.down += d.length; socket.write(d); });
    });
    const close = () => { if (entry.closedMs === undefined) entry.closedMs = Date.now() - t0; socket.destroy(); upstream.destroy(); };
    sockets.add(upstream);
    upstream.on('error', err => { entry.error = String(err.code ?? err); close(); });
    upstream.on('close', close);
    socket.on('close', close);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        tunnels,
        // Per-host totals: tunnels, bytes up/down.
        summary() {
          const hosts = {};
          for (const t of tunnels) {
            const h = (hosts[`${t.host}:${t.port}`] ??= { tunnels: 0, up: 0, down: 0, denied: 0, firstMs: t.openedMs });
            h.tunnels++; h.up += t.up; h.down += t.down; if (t.denied) h.denied++;
          }
          return hosts;
        },
        // Simulates the network going away: open tunnels are torn down, new ones refused.
        cut() { cut = true; for (const s of sockets) s.destroy(); return Date.now() - t0; },
        restore() { cut = false; },
        close: () => new Promise(r => {
          for (const s of sockets) s.destroy();
          server.closeAllConnections?.();
          server.close(() => r());
          setTimeout(r, 2000).unref();
        }),
      });
    });
  });
}
