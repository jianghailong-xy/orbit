// The runner's view of the wire for the startNow / Create and start run: a loopback reverse proxy between the
// runner and its apiserver (PROXY_PORT -> API_PORT), adapted from the R29-13 kit's proxy.mjs. Everything is passed
// through unchanged and unbuffered. Written to WIRE_LOG (JSON lines): every request this feature consists of, with
// what the runner sent and what it was answered —
//   * POST /api/runner/sessions/:id/approvals            the card as filed (its input carries runAt / the preview)
//   * GET  /api/runner/sessions/:id/approvals/:approval  the decision, once it is no longer PENDING (startAfterCreate)
//   * POST /api/runner/tasks and /tasks/batch-create     the create body (runAt) and the created task(s)
//   * POST /api/runner/tasks/batch-preview               the batch card's forecast
//   * POST /api/runner/tasks/:id/execute                 the immediate start, and its answer
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const PROXY_PORT = Number(process.env.PROXY_PORT);
const API_PORT = Number(process.env.API_PORT);
const WIRE_LOG = process.env.WIRE_LOG;

const write = (rec) => appendFileSync(WIRE_LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
const parse = (buf) => { try { return JSON.parse(buf.toString('utf8')); } catch { return buf.toString('utf8').slice(0, 2000); } };

function interesting(method, path) {
  if (method === 'POST' && /^\/api\/runner\/sessions\/[^/]+\/approvals$/.test(path)) return 'card-filed';
  if (method === 'GET' && /^\/api\/runner\/sessions\/[^/]+\/approvals\/[^/]+$/.test(path)) return 'card-poll';
  if (method === 'POST' && path === '/api/runner/tasks') return 'task-create';
  if (method === 'POST' && path === '/api/runner/tasks/batch-create') return 'batch-create';
  if (method === 'POST' && path === '/api/runner/tasks/batch-preview') return 'batch-preview';
  if (method === 'POST' && /^\/api\/runner\/tasks\/[^/]+\/execute$/.test(path)) return 'task-start';
  return null;
}

http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  const kind = interesting(req.method, path);
  const reqChunks = [];
  const upstream = http.request({
    host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers: req.headers,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    const resChunks = [];
    up.on('data', (c) => { if (kind) resChunks.push(c); res.write(c); });
    up.on('end', () => {
      res.end();
      if (!kind) return;
      try {
        const answer = parse(Buffer.concat(resChunks));
        // A long-poll window that elapsed undecided says nothing; the answer that ends the wait is the record.
        if (kind === 'card-poll' && answer && answer.status === 'PENDING') return;
        write({ kind, method: req.method, path, status: up.statusCode, request: reqChunks.length ? parse(Buffer.concat(reqChunks)) : null, answer });
      } catch (e) {
        write({ kind: 'proxy-error', path, error: String(e) });
      }
    });
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`proxy: ${e.message}`);
  });
  req.on('data', (c) => { if (kind) reqChunks.push(c); upstream.write(c); });
  req.on('end', () => upstream.end());
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
}).listen(PROXY_PORT, '127.0.0.1', () => console.log(`proxy 127.0.0.1:${PROXY_PORT} -> 127.0.0.1:${API_PORT}, wire log ${WIRE_LOG}`));
