// The runner's view of the wire: a loopback reverse proxy between the stack runner and its apiserver
// (PROXY_PORT -> API_PORT). Everything is passed through unchanged and unbuffered. Written to WIRE_LOG
// (JSON lines), so a reader can see what each runner declared and what it was handed:
//   * every POST /api/runner/heartbeat: the X-Orbit-Runner-Capabilities header (whether it carries
//     integration-observe/v1), the runner version, and every integration job the answer handed out (whole);
//   * every POST /api/runner/integration-jobs/:id/{result,release}: the runner's answer (whole);
//   * progress reports: the phase only.
// Heartbeats that hand out nothing are logged as one compact line each (time, version, capability flag).
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const PROXY_PORT = Number(process.env.PROXY_PORT);
const API_PORT = Number(process.env.API_PORT);
const WIRE_LOG = process.env.WIRE_LOG;
const OBSERVE = 'integration-observe/v1';
const JOB = 'integration-job/v1';

const write = (rec) => appendFileSync(WIRE_LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
const parse = (buf) => { try { return JSON.parse(buf.toString('utf8')); } catch { return undefined; } };

function interesting(path) {
  if (path === '/api/runner/heartbeat') return 'heartbeat';
  const m = path.match(/^\/api\/runner\/integration-jobs\/([^/]+)\/(result|release|progress)$/);
  return m ? `job-${m[2]}` : null;
}

http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  const kind = interesting(path);
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
        const body = parse(Buffer.concat(reqChunks));
        const answer = parse(Buffer.concat(resChunks));
        const caps = String(req.headers['x-orbit-runner-capabilities'] || '');
        if (kind === 'heartbeat') {
          const jobs = answer?.integrationJobs ?? [];
          write({
            kind, status: up.statusCode, version: body?.version ?? null,
            declaresIntegrationJob: caps.split(',').includes(JOB),
            declaresIntegrationObserve: caps.split(',').includes(OBSERVE),
            ...(jobs.length ? { integrationJobs: jobs } : {}),
          });
        } else if (kind === 'job-progress') {
          write({ kind, path, status: up.statusCode, phase: body?.phase ?? null });
        } else {
          write({ kind, path, status: up.statusCode, request: body, answer });
        }
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
