// T07: the real web app, built from this checkout, in a real Chromium on the HPC host, against the lab's
// test server (served same-origin by serve-web.mjs on 127.0.0.1). One browser per account: it signs in
// through the login page, opens a page, and from then on writes one line and one picture each time what
// the page shows of the managed runner changes -- the notice's kind, title and words, the composer's
// state, the session's answers -- and does what it is told through command files (type and send, Retry,
// open a page, a picture). Nothing here is a fixture: every answer is the test server's.
//
//   node t07web.mjs run --account NAME --out DIR [--start PATH] [--base URL]
//   node t07web.mjs act --out DIR KIND [ARG]   KIND: goto PATH | send TEXT | retry | shot LABEL | wait-text TEXT
//
// Passwords are read from $LAB_TEST_SERVER_DIR/state/NAME.json (0600) and never written out.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const TREE = process.env.T07_WT ?? '/root/.orbit/worktrees/7ddda73b-7127-5859-a253-c2d61bb5aa40';
const SERVER = process.env.LAB_TEST_SERVER_DIR ?? '/mnt/data/managed-runner-lab/test-server-t07';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const iso = () => new Date().toISOString();

async function run() {
  const { chromium } = await import(`${TREE}/node_modules/playwright/index.mjs`);
  const account = flag('account');
  const out = flag('out');
  const base = flag('base', 'http://127.0.0.1:5873');
  const start = flag('start', '/');
  mkdirSync(join(out, 'cmd'), { recursive: true });
  mkdirSync(join(out, 'shots'), { recursive: true });
  const logFile = join(out, 'web.jsonl');
  const log = (record) => appendFileSync(logFile, JSON.stringify({ at: iso(), ...record }) + '\n');
  const state = JSON.parse(readFileSync(join(SERVER, 'state', `${account}.json`), 'utf8'));

  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log({ kind: 'console-error', text: m.text().slice(0, 300) }); });
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/') && r.status() >= 400) log({ kind: 'api-error', status: r.status(), path: url.pathname + url.search });
  });
  page.on('request', (r) => {
    const url = new URL(r.url());
    // A sign-in's body is a password and a refresh's a token: their paths only.
    if (url.pathname.startsWith('/api/') && r.method() !== 'GET') {
      log({ kind: 'api-write', method: r.method(), path: url.pathname,
        body: url.pathname.startsWith('/api/auth/') ? '(not logged)' : (r.postData() ?? '').slice(0, 400) });
    }
  });

  // Sign in through the login page, as a person does.
  await page.goto(`${base}/login`);
  await page.fill('input[name="email"]', state.email);
  await page.fill('input[autocomplete="current-password"]', state.password);
  await page.click('button.login-submit');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  log({ kind: 'signed-in', url: page.url() });
  if (start !== '/') await page.goto(`${base}${start}`);

  let n = 0;
  let last = '';
  const shot = async (label) => {
    n += 1;
    const file = `${String(n).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 60)}.png`;
    await page.screenshot({ path: join(out, 'shots', file) });
    return file;
  };
  const observe = () => page.evaluate(() => {
    const notice = document.querySelector('.managed-runner-notice');
    const area = document.querySelector('.workspace-composer textarea');
    const send = document.querySelector('button[aria-label="Send"]');
    const text = document.body.innerText;
    return {
      path: location.pathname,
      notice: notice ? {
        kind: notice.getAttribute('data-kind'),
        title: notice.querySelector('.managed-runner-notice-title')?.textContent ?? null,
        detail: notice.querySelector('.managed-runner-notice-detail')?.textContent ?? null,
        actions: [...notice.querySelectorAll('button, a')].map((b) => b.textContent),
      } : null,
      composer: area ? { placeholder: area.getAttribute('placeholder'), hero: !!document.querySelector('.np-hero'),
        modelChip: document.querySelector('.composer-model-chip')?.textContent ?? null, sendEnabled: send ? !send.disabled : null } : null,
      answers: [...new Set(text.match(/Answering: T07-[A-Z0-9-]+/g) ?? [])],
      register: /register your own machine|register a runner/i.test(text),
      loading: !!document.querySelector('.ant-spin-spinning, .spinner, [aria-busy="true"]') && !notice,
    };
  });

  const deadline = Number(flag('seconds', '0')) ? Date.now() + Number(flag('seconds')) * 1000 : null;
  while (!existsSync(join(out, 'stop')) && (!deadline || Date.now() < deadline)) {
    try {
      const seen = await observe();
      const key = JSON.stringify(seen);
      if (key !== last) {
        last = key;
        const label = seen.notice ? seen.notice.kind : (seen.composer ? (seen.composer.hero ? 'composer-ready' : 'composer') : 'page');
        const file = await shot(`${label}${seen.answers.length ? '-answered' : ''}`);
        log({ kind: 'seen', shot: file, ...seen });
      }
      for (const name of readdirSync(join(out, 'cmd')).filter((f) => f.endsWith('.json')).sort()) {
        const done = join(out, 'cmd', name.replace(/\.json$/, '.done'));
        if (existsSync(done)) continue;
        const order = JSON.parse(readFileSync(join(out, 'cmd', name), 'utf8'));
        let result;
        try {
          result = await act(page, base, order, shot);
        } catch (error) {
          result = { error: String(error).slice(0, 300) };
        }
        log({ kind: 'act', order, result });
        writeFileSync(done, JSON.stringify(result));
      }
    } catch (error) {
      log({ kind: 'error', error: String(error).slice(0, 300) });
    }
    await page.waitForTimeout(700);
  }
  log({ kind: 'stopped' });
  await browser.close();
}

async function act(page, base, order, shot) {
  switch (order.kind) {
    case 'goto':
      await page.goto(`${base}${order.arg}`);
      return { url: page.url() };
    case 'send': {
      const area = page.locator('.workspace-composer textarea');
      await area.click();
      await area.fill(order.arg);
      const send = page.locator('button[aria-label="Send"]');
      await send.waitFor({ state: 'visible', timeout: 10_000 });
      const before = await shot('before-send');
      await send.click();
      return { sent: order.arg, before };
    }
    case 'retry': {
      const button = page.locator('.managed-runner-notice button', { hasText: 'Retry' });
      const before = await shot('before-retry');
      await button.click({ timeout: 10_000 });
      return { pressed: 'Retry', before };
    }
    case 'shot':
      return { shot: await shot(order.arg) };
    case 'wait-text':
      await page.getByText(order.arg).first().waitFor({ timeout: 300_000 });
      return { found: order.arg, shot: await shot('found') };
    default:
      throw new Error(`unknown action ${order.kind}`);
  }
}

async function enqueue() {
  const out = flag('out');
  const positional = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--out') { i += 1; continue; }
    positional.push(argv[i]);
  }
  const [kind, ...rest] = positional;
  const dir = join(out, 'cmd');
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  const file = join(dir, `${String(n).padStart(4, '0')}.json`);
  writeFileSync(file, JSON.stringify({ kind, arg: rest.join(' '), at: iso() }));
  const done = file.replace(/\.json$/, '.done');
  const until = Date.now() + 330_000;
  while (!existsSync(done)) {
    if (Date.now() > until) throw new Error(`the browser did not take ${file} in time`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(readFileSync(done, 'utf8'));
}

if (argv[0] === 'run') await run();
else if (argv[0] === 'act') await enqueue();
else throw new Error('usage: run|act');
