// The fake Kimi server of the local Kimi-accounts stack: Kimi's sign-in site (RFC 8628 device
// authorization, token refresh) and the Kimi Code API's GET <base_url>/usages, for every host the
// stack maps to 127.0.0.1 (auth.kimi.com, api.kimi.com, auth.kimi.ai, api.kimi.ai). Loopback only.
//
// What a user does in a browser — approve a device code as one of their Kimi accounts — is the admin
// API's: POST /__admin/approve {userCode, user}. Each account ("user") has its own quota, set with
// POST /__admin/usage {user, limit_5h, limit_7d, limit_month_total, limit_month_code} (used ratios,
// 0..1). GET /__admin/state shows it all (token values only as sha-256 prefixes).
//
// usage: node fake-kimi-server.mjs <port> <state.json> <requests.jsonl>
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [port = '18741', stateFile = './fake-kimi-state.json', logFile = './fake-kimi-requests.jsonl'] = process.argv.slice(2);
const ACCESS_TTL = Number(process.env.FAKE_KIMI_ACCESS_TTL || 900);
const h = (s) => (s ? createHash('sha256').update(String(s)).digest('hex').slice(0, 10) : null);

let state = { devices: {}, users: {}, access: {}, refresh: {}, seq: 0 };
if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, 'utf8'));
const save = () => { writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2)); renameSync(stateFile + '.tmp', stateFile); };

function reset(hours) {
  return new Date(Date.now() + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function nextMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function user(name, region) {
  state.users[name] ??= { name, region, ratios: { limit_5h: 0.1, limit_7d: 0.05, limit_month_total: 0.02, limit_month_code: 0.01 }, resets: {} };
  return state.users[name];
}
function issue(name, ttl = ACCESS_TTL) {
  const access = 'fk_at_' + randomBytes(18).toString('base64url');
  const refresh = 'fk_rt_' + randomBytes(18).toString('base64url');
  state.access[access] = { user: name, exp: Date.now() + ttl * 1000 };
  state.refresh[refresh] = { user: name };
  return { access_token: access, refresh_token: refresh, expires_in: ttl, scope: 'kimi-code', token_type: 'Bearer' };
}
function code() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from(randomBytes(4), (b) => a[b % a.length]).join('');
  return `${pick()}-${pick()}`;
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] || '').includes('json')) { try { return JSON.parse(text || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(text));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const entry = { at: new Date().toISOString(), method: req.method, host: req.headers.host, path: url.pathname };
  const send = (status, value) => {
    entry.status = status;
    appendFileSync(logFile, JSON.stringify(entry) + '\n');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  try {
    const b = req.method === 'POST' ? await body(req) : {};
    if (req.method === 'POST' && url.pathname === '/api/oauth/device_authorization') {
      const device = 'fk_dc_' + randomBytes(12).toString('base64url');
      const userCode = code();
      state.devices[device] = { userCode, region: b.region || 'mainland-cn', status: 'pending', home: req.headers['x-fake-kimi-home'] || null, deviceId: b.device_id || null, at: entry.at };
      save();
      Object.assign(entry, { userCode, region: b.region, home: req.headers['x-fake-kimi-home'] });
      const www = b.region === 'global' ? 'https://www.kimi.ai' : 'https://www.kimi.com';
      return send(200, { device_code: device, user_code: userCode, verification_uri: `${www}/code/authorize_device`, verification_uri_complete: `${www}/code/authorize_device?user_code=${userCode}`, expires_in: 1800, interval: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/api/oauth/token') {
      entry.grant = b.grant_type;
      if (b.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const d = state.devices[b.device_code];
        if (!d) return send(400, { error: 'invalid_grant' });
        entry.userCode = d.userCode;
        if (d.status === 'pending') return send(400, { error: 'authorization_pending' });
        if (d.status === 'denied') return send(400, { error: 'access_denied' });
        if (d.status === 'used') return send(400, { error: 'invalid_grant' });
        d.status = 'used';
        const t = issue(d.user, d.ttl);
        save();
        Object.assign(entry, { user: d.user, expiresIn: t.expires_in });
        return send(200, { ...t, fake_user: d.user });
      }
      if (b.grant_type === 'refresh_token') {
        const r = state.refresh[b.refresh_token];
        entry.refresh = h(b.refresh_token);
        if (!r) return send(401, { error: 'invalid_grant' });
        delete state.refresh[b.refresh_token]; // rotated: a refresh token is spent once
        const t = issue(r.user);
        save();
        Object.assign(entry, { user: r.user, expiresIn: t.expires_in, newToken: h(t.access_token) });
        return send(200, t);
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/coding/v1/usages')) {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = state.access[token];
      entry.token = h(token);
      if (!a || a.exp < Date.now()) return send(401, { error: { message: 'invalid or expired token' } });
      const u = state.users[a.user];
      entry.user = a.user;
      const window = (k, hours) => ({ used_ratio: u.ratios[k], reset_time: u.resets[k] || (hours ? reset(hours) : nextMonth()) });
      return send(200, {
        usages: { limit_5h: window('limit_5h', 2.5), limit_7d: window('limit_7d', 75), limit_month_total: window('limit_month_total', 0), limit_month_code: window('limit_month_code', 0) },
        boosterWallet: { balance: 0, currency: 'CNY' },
      });
    }
    // ── admin (the stack's scenario scripts) ──
    if (url.pathname === '/__admin/state') {
      return send(200, {
        devices: state.devices, users: state.users,
        access: Object.fromEntries(Object.entries(state.access).map(([k, v]) => [h(k), { ...v, exp: new Date(v.exp).toISOString() }])),
        refresh: Object.fromEntries(Object.entries(state.refresh).map(([k, v]) => [h(k), v])),
      });
    }
    if (req.method === 'POST' && url.pathname === '/__admin/approve') {
      const found = Object.values(state.devices).find((d) => d.userCode === b.userCode && d.status === 'pending');
      if (!found) return send(404, { error: `no pending device code ${b.userCode}` });
      Object.assign(found, { status: 'approved', user: b.user, ...(b.ttl ? { ttl: Number(b.ttl) } : {}) });
      user(b.user, found.region);
      save();
      Object.assign(entry, { userCode: b.userCode, user: b.user });
      return send(200, { ok: true, user: b.user, region: found.region });
    }
    if (req.method === 'POST' && url.pathname === '/__admin/deny') {
      const found = Object.values(state.devices).find((d) => d.userCode === b.userCode && d.status === 'pending');
      if (!found) return send(404, { error: `no pending device code ${b.userCode}` });
      found.status = 'denied';
      save();
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__admin/usage') {
      const u = state.users[b.user];
      if (!u) return send(404, { error: `no user ${b.user}` });
      for (const k of ['limit_5h', 'limit_7d', 'limit_month_total', 'limit_month_code']) {
        if (b[k] !== undefined) u.ratios[k] = Number(b[k]);
      }
      save();
      Object.assign(entry, { user: b.user, ratios: u.ratios });
      return send(200, u);
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    entry.error = String(e?.message || e);
    return send(500, { error: 'internal' });
  }
});
server.listen(Number(port), '127.0.0.1', () => console.log(`fake kimi server on 127.0.0.1:${port}`));
