// The Scheduled page chat against this branch's real apiserver (no fake API): the built web through gateway.mjs
// (127.0.0.1:2757 → :3757), signed in with the seeded owner's real tokens. Records every /api/schedules/chat and
// /api/sessions answer the page received into <out>/payloads/, the measured column boxes into <out>/report.json, and
// a screenshot per scene. Run: node capture.mjs <repo> <out> (stack.sh record does).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [W, OUT] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(path.join(W, 'node_modules/playwright-core/index.mjs')).href);
const state = JSON.parse(fs.readFileSync(path.join(process.env.STACK_DIR ?? '/var/tmp/sched-chat-stack', 'state.json'), 'utf8'));
const BASE = 'http://127.0.0.1:2757';
const ws = state.workspaces;
const audit = state.schedules.find((s) => s.title === 'Nightly dependency audit').id;
fs.mkdirSync(path.join(OUT, 'payloads'), { recursive: true });

const SCENES = [
  { name: '1460-closed', width: 1460, url: `/scheduled?id=${audit}` },
  { name: '1460-docked', width: 1460, url: `/scheduled?id=${audit}`, press: true },
  { name: '1460-new-chat', width: 1460, url: `/scheduled?id=${audit}&workspace=${ws.apiserver}&chat=new` },
  { name: '1280-rail', width: 1280, url: `/scheduled?id=${audit}&chat=${state.chat}` },
  { name: '1024-over', width: 1024, url: `/scheduled?chat=${state.chat}` },
  // A first message from the page on a new chat in the other workspace: the page's own POST and its answer.
  { name: '1460-sent', width: 1460, url: `/scheduled?workspace=${ws.web}&chat=new`, send: 'Pause the changelog watches until Monday.' },
  // A refresh of the address the panel wrote: the same chat comes back.
  { name: '1460-refreshed', width: 1460, url: null, refreshOf: '1460-sent' },
  // The title opens this account's Scheduled chats, read from the server's own session rows.
  { name: '1460-history', width: 1460, url: `/scheduled?chat=${state.chat}`, history: true },
];

const browser = await chromium.launch();
const report = [];
const hrefs = {};
const received = [];
for (const scene of SCENES) {
  const context = await browser.newContext({ viewport: { width: scene.width, height: 900 }, timezoneId: 'Asia/Shanghai', locale: 'en-US' });
  await context.addInitScript(({ token, refresh }) => {
    if (!localStorage.getItem('orbit_token')) {
      localStorage.setItem('orbit_token', token);
      localStorage.setItem('orbit_refresh', refresh);
    }
  }, { token: state.token, refresh: state.refreshToken });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', async (response) => {
    const url = new URL(response.url());
    const p = url.pathname;
    if (!(p === '/api/schedules/chat' || p === '/api/sessions')) return;
    const request = response.request();
    let body = null;
    try { body = await response.json(); } catch { /* 304 or empty */ }
    received.push({ scene: scene.name, method: request.method(), path: p + url.search, status: response.status(), request: request.postDataJSON?.() ?? null, body });
  });
  const url = scene.refreshOf ? hrefs[scene.refreshOf] : scene.url;
  await page.goto(BASE + url);
  await page.waitForSelector('.sched-page');
  await page.waitForTimeout(1500);
  if (scene.press) {
    await page.click('.sched-chat-btn');
    await page.waitForTimeout(1500);
  }
  if (scene.history) {
    await page.click('.wk-chat-title');
    await page.waitForTimeout(1500);
  }
  if (scene.send) {
    const box = page.locator('.wk-chat-composer textarea').first();
    await box.click();
    await box.fill(scene.send);
    await page.click('.wk-chat-composer [aria-label="Send"]');
    await page.waitForTimeout(2500);
  }
  const facts = await page.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; };
    return {
      href: location.pathname + location.search,
      panel: document.querySelector('.wk-chat-panel')?.className ?? null,
      title: document.querySelector('.wk-chat-title .t')?.textContent ?? null,
      runsIn: document.querySelector('.wk-chat-run select')?.selectedOptions?.[0]?.textContent ?? null,
      note: document.querySelector('.wk-chat-note')?.textContent ?? null,
      opening: document.querySelector('.wk-chat-empty')?.textContent ?? null,
      history: [...document.querySelectorAll('.wk-chat-history-row .t')].map((t) => t.textContent),
      button: document.querySelector('.sched-chat-btn')?.getAttribute('aria-pressed') ?? null,
      nav: box('.app-nav'), list: box('.sched-list'), inspector: box('.sched-inspector'), chat: box('.wk-chat-panel'),
    };
  });
  hrefs[scene.name] = facts.href;
  await page.screenshot({ path: path.join(OUT, `${scene.name}.png`) });
  report.push({ scene: scene.name, loaded: url, ...facts, errors });
  await context.close();
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT, 'payloads', 'received.json'), JSON.stringify(received, null, 2));
// The three shapes the panel reads, as the page received them.
const first = (pred) => received.find(pred)?.body ?? null;
fs.writeFileSync(path.join(OUT, 'payloads', 'get-schedules-chat.json'), JSON.stringify(first((r) => r.method === 'GET' && r.path.startsWith('/api/schedules/chat')), null, 2));
fs.writeFileSync(path.join(OUT, 'payloads', 'post-schedules-chat.json'), JSON.stringify({
  request: received.find((r) => r.method === 'POST' && r.path === '/api/schedules/chat')?.request ?? null,
  answer: first((r) => r.method === 'POST' && r.path === '/api/schedules/chat'),
}, null, 2));
const lists = received.filter((r) => r.method === 'GET' && r.path.startsWith('/api/sessions') && r.body);
const rows = lists.flatMap((r) => (Array.isArray(r.body) ? r.body : r.body.sessions ?? r.body.upserts ?? []));
fs.writeFileSync(path.join(OUT, 'payloads', 'session-rows.json'), JSON.stringify(rows.filter((row) => row.chatOrigin === 'SCHEDULE_CHAT'), null, 2));
console.log(JSON.stringify(report.map(({ opening, ...r }) => r), null, 2));
