// Tiny HTTP client for the isolated A11 stack (127.0.0.1:<A11_STACK_API_PORT, default 3711>/api). Never points
// anywhere but loopback. The stack directory is A11_STACK_DIR (default /var/tmp/a11-stack), as for setup.sh.
import { readFileSync, existsSync } from 'node:fs';

export const S = process.env.A11_STACK_DIR || '/var/tmp/a11-stack';
export const API = `http://127.0.0.1:${Number(process.env.A11_STACK_API_PORT || 3711)}/api`;

export class HttpError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> ${status} ${body.slice(0, 600)}`);
    this.status = status;
    this.body = body;
  }
}

export async function call(method, path, bearer, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(method, path, res.status, text);
  return text ? JSON.parse(text) : undefined;
}

// Fresh owner/member tokens from the recorded test accounts (login through the real API).
export async function login(who = 'owner') {
  const accounts = JSON.parse(readFileSync(`${S}/accounts.json`, 'utf8'));
  const a = accounts[who];
  return (await call('POST', '/auth/login', undefined, { email: a.email, password: a.password })).accessToken;
}

export const seedFile = `${S}/seed.json`;
export const readSeed = () => (existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, 'utf8')) : {});
