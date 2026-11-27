// The page chat's states on the real stack (after seed.mjs and chat-changes.mjs): the amber count with the panel
// closed, the chat with its chip, change line and waiting card, and the Run now button before and after the press.
// The runner daemon's event ingest is runner-link only, so the agent's one sentence with the Run now link is added to
// the session's events as the page reads them (the only thing not from the server); everything else is the server's.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [W, OUT] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(path.join(W, 'node_modules/playwright-core/index.mjs')).href);
const state = JSON.parse(fs.readFileSync(path.join(process.env.STACK_DIR ?? '/var/tmp/sched-chat-stack', 'state.json'), 'utf8'));
const codex = state.schedules.find((s) => s.title === 'Codex stable check').id;
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:2757';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1460, height: 900 }, timezoneId: 'Asia/Shanghai', locale: 'en-US' });
await context.addInitScript(({ token, refresh }) => {
  if (!localStorage.getItem('orbit_token')) { localStorage.setItem('orbit_token', token); localStorage.setItem('orbit_refresh', refresh); }
}, { token: state.token, refresh: state.refreshToken });
const page = await context.newPage();
const seen = [];
page.on('request', (r) => { if (r.url().includes(state.chat) || r.url().includes('/run')) seen.push(`${r.method()} ${new URL(r.url()).pathname}`); });
const offer = { seq: 1000, type: 'assistant', ts: new Date().toISOString(), payload: { text: `Press it here and it starts right away. A press from you does not count toward any limit: [Run now](orbit-run-now:${codex})` } };
await page.route((u) => u.pathname.startsWith(`/api/sessions/${state.chat}/events`) || u.pathname === `/api/sessions/${state.chat}/transcript`, async (route) => {
  const response = await route.fetch();
  let body; try { body = await response.json(); } catch { return route.fulfill({ response }); }
  const list = Array.isArray(body) ? body : body.events;
  if (Array.isArray(list)) list.push(offer);
  await route.fulfill({ response, json: body });
});
await page.goto(`${BASE}/scheduled?id=${codex}`);
await page.waitForSelector('.sched-page');
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(OUT, '1-card-waiting-panel-closed.png') });
const closed = await page.evaluate(() => ({ state: document.querySelector('.sched-chat-btn')?.getAttribute('data-state'), count: document.querySelector('[data-chat-count]')?.textContent }));
await page.click('.sched-chat-btn');
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(OUT, '2-chat-chip-change-line-card.png') });
const open = await page.evaluate(() => ({
  chip: document.querySelector('.wk-chat-chip[data-kind="schedule"]')?.textContent,
  record: document.querySelector('[data-schedule-record]')?.textContent,
  card: document.querySelector('.sched-card, [data-schedule-card]')?.textContent?.slice(0, 120),
  runNow: !!document.querySelector('[data-run-now]'),
  flash: document.querySelector('.sched-row.is-flash') !== null,
}));
const runNow = page.locator('[data-run-now] button').first();
if (await runNow.count()) {
  await runNow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, '3-run-now-offer.png') });
  await runNow.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, '4-run-now-started.png') });
}
const after = await page.evaluate(() => document.querySelector('[data-run-now]')?.textContent);
console.log(JSON.stringify({ closed, open, after, seen: seen.filter((s) => s.includes('/run') || s.includes('events')).slice(0, 8) }, null, 2));
await browser.close();
