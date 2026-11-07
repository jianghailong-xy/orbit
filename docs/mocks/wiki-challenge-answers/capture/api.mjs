// Tiny client for the private stack: owner calls with the saved access token, runner calls with the runner token.
import fs from 'node:fs';
export const S = '/mnt/data/tmp/34tDf8/stack';
export const API = 'http://127.0.0.1:3734/api';
export function state() { try { return JSON.parse(fs.readFileSync(`${S}/seed.json`, 'utf8')); } catch { return {}; } }
export function save(patch) { const next = { ...state(), ...patch }; fs.writeFileSync(`${S}/seed.json`, JSON.stringify(next, null, 1), { mode: 0o600 }); return next; }
export async function call(method, path, body, { as = 'owner', session } = {}) {
  const st = state();
  const headers = { 'content-type': 'application/json' };
  if (as === 'owner' && st.accessToken) headers.authorization = `Bearer ${st.accessToken}`;
  if (as === 'runner') { headers['x-runner-token'] = st.runnerToken; if (session) headers['x-orbit-session-id'] = session; }
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 1500)}`); e.status = res.status; e.body = json; throw e; }
  return json;
}
