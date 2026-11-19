// Drives the real session page (built dist) with the ui-migration fixtures and scripted stream frames.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
const W = '/root/.orbit/worktrees/01a1c925-53a8-7320-aa21-69e8cf171911';
const { chromium } = await import(`${W}/node_modules/playwright-core/index.mjs`);
const { installFixtures } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { SESSION_PATH, SESSION_TIME } = await import(`${W}/src/web/ui-migration/session-fixtures.mjs`);
const OUT = '/mnt/data/tmp/thinking-fold/shots';
const DIST = `${W}/src/web/dist`;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(p) || p.endsWith('/')) p = join(DIST, 'index.html');
  try { res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }); res.end(readFileSync(p)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome', env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/tmp/thinking-fold/fonts.conf' } });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await installFixtures(page, { theme: 'light' });
await page.goto(BASE + SESSION_PATH);
await page.waitForFunction((path) => window.__uiMigrationStreams?.some((s) => s.readyState === 1 && new URL(s.url).pathname === `/api${path}/events`), SESSION_PATH);
const T = 'turn-think-1';
const emit = (frames) => page.evaluate(({ path, frames }) => {
  const s = window.__uiMigrationStreams.findLast((e) => e.readyState === 1 && new URL(e.url).pathname === `/api${path}/events`);
  for (const f of frames) s.emit(f);
}, { path: SESSION_PATH, frames: frames.map((f) => ({ turnId: T, ts: SESSION_TIME, ...f })) });
const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const head = () => page.locator('.chat-think-live-head');
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const para = (i) => `Step ${i}: weighing whether the wakeup loop alerts when it goes silent, and which task sessions it covers.\n\n`;

await emit([{ seq: 4, type: 'user', payload: { text: 'Check the wakeups on the project sessions.' } }]);
for (let i = 1; i <= 3; i++) await emit([{ seq: 0, type: 'thinking_delta', payload: { text: para(i) } }]);
await head().waitFor();
const t0 = await head().innerText();
check('1. a live block starts as one folded row', (await head().getAttribute('aria-expanded')) === 'false' && (await page.locator('.chat-think-port').count()) === 0, JSON.stringify(t0));
const h0 = await page.locator('.chat-think-live').boundingBox();
check('1b. the folded row is one line tall', h0.height < 30, `${h0.height}px`);
await shot('01-folded');
await page.waitForTimeout(2200);
for (let i = 4; i <= 12; i++) await emit([{ seq: 0, type: 'thinking_delta', payload: { text: para(i) } }]);
const t1 = await head().innerText();
check('2. clock and size keep moving while folded', t1 !== t0 && /\ds/.test(t1), `${JSON.stringify(t0)} → ${JSON.stringify(t1)}`);
const anim = await page.locator('.chat-think-live-word').evaluate((e) => getComputedStyle(e).animationName);
check('2b. the word carries the sweep', anim === 'chat-think-sweep', anim);
await shot('02-folded-later');
await head().click();
await page.locator('.chat-think-port').waitFor();
const port = page.locator('.chat-think-port');
const fade = await port.evaluate((e) => ({ scrolled: e.classList.contains('is-scrolled'), mask: getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage, atEnd: e.scrollHeight - e.scrollTop - e.clientHeight < 8, h: e.clientHeight }));
check('3. a click opens it at its newest line', (await head().getAttribute('aria-expanded')) === 'true' && fade.atEnd, JSON.stringify(fade));
check('3b. the top edge fades instead of cutting a line', fade.scrolled && /gradient/.test(fade.mask), fade.mask);
await shot('03-open');
// The block settles (Claude: empty text, the runner's time), then a tool call, then the next block streams.
await emit([{ seq: 5, type: 'thinking', payload: { text: '', thinkingMs: 9000 } },
  { seq: 6, type: 'tool_use', payload: { id: 'toolu_1', name: 'Bash', input: { command: 'orbit wakeup list --project p1' } } },
  { seq: 7, type: 'tool_result', payload: { toolUseId: 'toolu_1', content: '3 wakeups' } }]);
await page.waitForTimeout(300);
check('4. the settled block leaves the live row', (await head().count()) === 0);
await shot('04-settled');
await emit([{ seq: 0, type: 'thinking_delta', payload: { text: 'Three wakeups. Next, which of them fired late.' } }]);
await head().waitFor();
check('5. the next block of the same turn opens as the reader left it', (await head().getAttribute('aria-expanded')) === 'true');
await shot('05-next-block-open');
await emit([{ seq: 8, type: 'thinking', payload: { text: '', thinkingMs: 2000 } }, { seq: 9, type: 'assistant', payload: { text: 'All three fired on time.' } }, { seq: 10, type: 'turn_end', payload: {} }]);
await page.waitForTimeout(500);
await emit([{ seq: 11, type: 'user', payload: { text: 'And the coordinator?' } }, { seq: 0, type: 'thinking_delta', payload: { text: 'Looking at the coordinator session next.' } }]);
await head().waitFor();
check('6. the next turn starts folded again', (await head().getAttribute('aria-expanded')) === 'false', await head().innerText());
await shot('06-next-turn-folded');
check('7. no page errors', errors.length === 0, errors.join(' | '));
console.log(results.join('\n'));
await browser.close(); server.close();
