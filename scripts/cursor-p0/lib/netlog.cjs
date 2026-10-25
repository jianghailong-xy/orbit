// Preloaded with NODE_OPTIONS=--require into the Cursor CLI (and every node child it starts) for
// the egress-inventory scenario only. It records which host and request path each outgoing call
// uses — never headers or bodies — so RPC names (e.g. /aiserver.v1.DashboardService/...) can be
// listed per phase. Query values are dropped at the source, so nothing secret reaches the log.
'use strict';
const fs = require('node:fs');
const file = process.env.P0_NET_LOG;
if (file) {
  const t0 = Date.now();
  const write = (kind, fields) => {
    try { fs.appendFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, kind, ...fields }) + '\n'); } catch {}
  };
  const cleanPath = p => {
    if (typeof p !== 'string') return p;
    const [path, query] = p.split('?');
    return query === undefined ? path : path + '?' + query.split('&').map(kv => kv.split('=')[0] + '=').join('&');
  };
  write('start', { argv: process.argv.slice(1, 3).map(a => a.replace(/^.*\//, '')), sinceStartMs: 0, startedAt: t0 });
  for (const mod of ['http', 'https']) {
    const m = require(mod);
    const orig = m.request;
    m.request = function (...args) {
      try {
        let url = args[0], opts = args[1];
        if (typeof url === 'string' || url instanceof URL) {
          const u = new URL(url);
          write(mod, { method: (opts && typeof opts === 'object' && opts.method) || 'GET', host: u.host, path: cleanPath(u.pathname + u.search) });
        } else if (url && typeof url === 'object') {
          write(mod, { method: url.method || 'GET', host: url.host || url.hostname, path: cleanPath(url.path || '/') });
        }
      } catch {}
      return orig.apply(this, args);
    };
    m.get = function (...args) { const r = m.request(...args); r.end(); return r; };
  }
  const http2 = require('node:http2');
  const origConnect = http2.connect;
  http2.connect = function (authority, ...rest) {
    const session = origConnect.call(this, authority, ...rest);
    const host = (() => { try { return new URL(String(authority)).host; } catch { return String(authority); } })();
    write('h2-connect', { host });
    const origRequest = session.request;
    session.request = function (headers, ...more) {
      try { write('h2', { host, method: headers && headers[':method'], path: cleanPath(headers && headers[':path']) }); } catch {}
      return origRequest.call(this, headers, ...more);
    };
    return session;
  };
  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      try {
        const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (u.protocol === 'http:' || u.protocol === 'https:') write('fetch', { method: (init && init.method) || (input && input.method) || 'GET', host: u.host, path: cleanPath(u.pathname + u.search) });
      } catch {}
      return origFetch.call(this, input, init);
    };
  }
}
