// Tiny HTTP client for the isolated A12 stack (127.0.0.1:<A12_STACK_API_PORT, default 3712>/api). Never points
// anywhere but loopback. The stack directory is A12_STACK_DIR (default /var/tmp/a12-stack), as for setup.sh.
import { readFileSync, existsSync } from 'node:fs';

export const S = process.env.A12_STACK_DIR || '/var/tmp/a12-stack';
export const API = `http://127.0.0.1:${Number(process.env.A12_STACK_API_PORT || 3712)}/api`;

export class HttpError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> ${status} ${body.slice(0, 600)}`);
    this.status = status;
    this.body = body;
  }
}

/** One request; the status and the parsed body, whatever the status. `who` is a bearer, or `{ runner, session }`. */
export async function request(method, path, who, body) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (typeof who === 'string') headers.authorization = `Bearer ${who}`;
  else if (who?.runner) {
    headers.authorization = `Bearer ${who.runner}`;
    if (who.session) headers['x-orbit-session-id'] = who.session;
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 600) }; }
  return { status: res.status, body: parsed, text };
}

/** A request that must succeed: its parsed body, or an HttpError. */
export async function call(method, path, who, body) {
  const answer = await request(method, path, who, body);
  if (answer.status < 200 || answer.status > 299) throw new HttpError(method, path, answer.status, answer.text);
  return answer.body ?? undefined;
}

// The server answers ids in its public (base62) spelling and accepts either; compare them as UUIDs
// (the codec of src/shared/src/codec.ts).
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidOf(id) {
  if (typeof id !== 'string' || id === '') return null;
  if (UUID_RE.test(id)) return id.toLowerCase();
  let n = 0n;
  for (const ch of id) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 62n + BigInt(v);
  }
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export const sameId = (a, b) => uuidOf(a) !== null && uuidOf(a) === uuidOf(b);

export const accountsFile = `${S}/accounts.json`;

/** A fresh token for one of the recorded test accounts (`owner` or `other`), through the real login. */
export async function login(who = 'owner') {
  const accounts = JSON.parse(readFileSync(accountsFile, 'utf8'));
  const a = accounts[who];
  if (!a) throw new Error(`no account "${who}" in ${accountsFile}`);
  return (await call('POST', '/auth/login', undefined, { email: a.email, password: a.password })).accessToken;
}

export const seedFile = `${S}/seed.json`;
export const readSeed = () => (existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, 'utf8')) : {});
