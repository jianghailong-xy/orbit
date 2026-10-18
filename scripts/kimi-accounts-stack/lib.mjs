// Helpers for the Kimi-accounts stack's scenario scripts: the stack's API (127.0.0.1 only), the fake Kimi
// server's admin API, the stack script, and a Playwright browser on the stack's web.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// This directory (scripts/kimi-accounts-stack), the checkout it is in, and the stack's own directory.
export const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
export const S = process.env.KIMI_STACK_DIR || '/var/tmp/kimi-accounts-stack';
export const WT = process.env.KIMI_STACK_REPO || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
export const API = `http://127.0.0.1:${process.env.KIMI_STACK_API_PORT || 3741}/api`;
export const WEB = `http://127.0.0.1:${process.env.KIMI_STACK_WEB_PORT || 4741}`;
export const MAIN_WEB = `http://127.0.0.1:${process.env.KIMI_STACK_MAIN_WEB_PORT || 4742}`;
export const FK = `http://127.0.0.1:${process.env.KIMI_STACK_FAKE_KIMI_PORT || 18741}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> ${status} ${body.slice(0, 800)}`);
    this.status = status;
    this.body = body;
  }
}

// Every API call a scenario makes is written to its log as one line: method, path, status, and the body sent.
let logFile = null;
export function logTo(file) { logFile = file; }
export function note(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  if (logFile) appendFileSync(logFile, line + '\n');
}

export async function call(method, path, bearer, body, { quiet = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const shown = body === undefined ? '' : ' ' + JSON.stringify(body, (k, v) => (k === 'password' ? '<redacted>' : v));
  if (!quiet) note(`→ ${method} /api${path}${shown} ← ${res.status}${res.ok ? '' : ' ' + text.slice(0, 600)}`);
  if (!res.ok) throw new HttpError(method, path, res.status, text);
  return text ? JSON.parse(text) : undefined;
}

export async function fk(method, path, body) {
  const res = await fetch(`${FK}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`fake kimi ${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export function stack(...args) {
  return execFileSync(`${HERE}/stack.sh`, args, { encoding: 'utf8' });
}

export const accounts = () => JSON.parse(readFileSync(`${S}/accounts.json`, 'utf8'));
export async function login() {
  const a = accounts().owner;
  return (await call('POST', '/auth/login', undefined, { email: a.email, password: a.password }, { quiet: true })).accessToken;
}
export const seed = () => (existsSync(`${S}/seed.json`) ? JSON.parse(readFileSync(`${S}/seed.json`, 'utf8')) : {});
export const saveSeed = (s) => writeFileSync(`${S}/seed.json`, JSON.stringify(s, null, 2) + '\n');

export async function until(what, fn, { timeoutMs = 120_000, everyMs = 1_500 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(everyMs);
  }
}

// A Chromium on the stack's web (the checkout's Playwright; PLAYWRIGHT_CHROMIUM names another binary, and
// KIMI_STACK_FONTCONFIG a fontconfig file for the shots).
export async function browser({ origin = WEB, width = 1440, height = 1000 } = {}) {
  const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
  const b = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
    args: ['--no-sandbox', '--lang=en-US', '--hide-scrollbars'],
    env: { ...process.env, ...(process.env.KIMI_STACK_FONTCONFIG ? { FONTCONFIG_FILE: process.env.KIMI_STACK_FONTCONFIG } : {}) },
  });
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => note('PAGE ERROR', String(e?.message || e).slice(0, 400)));
  page.on('console', (m) => { if (m.type() === 'error') note('console.error', m.text().slice(0, 300)); });
  return { b, ctx, page, origin };
}

export function shotDir(name) {
  const dir = `${S}/shots/${name}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}
