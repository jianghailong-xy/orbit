// Real-build shots of a Qwen (DashScope) session whose turn died on the 406 gateway timeout:
// before = main 1668e157f3, after = orbit/catch-8dae9c. Same fixtures, same events, same clock.
//   node capture.mjs <kitDir>
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const kit = process.argv[2] ?? '/var/tmp/dashscope-406-mock';
const { chromium } = await import(`${kit}/after/node_modules/playwright/index.mjs`);
const NOW = '2026-11-13T01:14:30.000Z'; // Fri, Nov 13, 9:14 AM Asia/Shanghai
const ERR = 'API Error: 406 Post "https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages": read tcp '
  + '[fdbd:dc53:2a:630::37]:38248->[64:ff9b::2fec:75bf]:443: read: connection timed out';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
function serve(dist) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = join(dist, p);
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    }).listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const boxes = {};
async function shoot(browser, tree, url, theme, size) {
  const fx = await import(`${kit}/${tree}/src/web/ui-migration/fixtures.mjs`);
  const sf = await import(`${kit}/${tree}/src/web/ui-migration/session-fixtures.mjs`);
  const viewport = size === 'phone' ? { width: 390, height: 844 } : { width: 1360, height: 860 };
  const page = await browser.newPage({ viewport, baseURL: url, locale: 'en-US', timezoneId: 'Asia/Shanghai', colorScheme: theme, deviceScaleFactor: 2 });
  await page.addInitScript((ts) => {
    window.Date = new Proxy(Date, {
      construct: (D, a) => Reflect.construct(D, a.length ? a : [ts]),
      apply: (D) => new D(ts).toString(),
      get: (D, k) => (k === 'now' ? () => ts : Reflect.get(D, k)),
    });
  }, Date.parse(NOW));
  await fx.installFixtures(page, { theme });
  const turn = sf.SESSION.id.slice(0, 20) + 'TT';
  const t0 = '2026-11-13T01:14:00.000Z';
  const session = {
    ...sf.SESSION, title: 'Translate the release notes', provider: 'qwen', model: 'qwen3.7-max',
    engine: 'claude', error: ERR, lastTurnAt: t0,
    // What the server leaves after a failed turn (sessionPhaseFields.fixture 'released with a retry armed'):
    // released FAILED, idle, the turn FAILED; armed, it waits on a WAKE.
    status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED', phase: tree === 'after' ? 'RUNNING' : 'IDLE', released: true, lastTurnOutcome: 'FAILED',
    waitingOn: tree === 'after' ? 'WAKE' : null, finishedAt: '2026-11-13T01:14:18.000Z',
    // What the server arms on a retryable failure (auto-retry.service): first rung, 30 s + jitter.
    ...(tree === 'after' ? { retryAt: '2026-11-13T01:14:57.000Z', retryAttempts: 0 } : { retryAt: null, retryAttempts: 0 }),
  };
  const events = [
    { seq: 1, type: 'user', payload: { text: 'Translate CHANGELOG.md into English and keep the headings.' }, turnId: turn, ts: t0 },
    { seq: 2, type: 'assistant', payload: { text: ERR }, turnId: turn, ts: '2026-11-13T01:14:18.000Z' },
    { seq: 3, type: 'turn_end', payload: { durationMs: 18000 }, turnId: turn, ts: '2026-11-13T01:14:18.000Z' },
  ];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fallback();
    if (path === '/api/providers') return route.fulfill({ json: [{ slug: 'qwen', label: 'Qwen (Model Studio)', runtime: 'claude',
      presetSlug: 'qwen', engines: ['claude'], models: [{ value: 'qwen3.7-max', label: 'Qwen3.7 Max' }], defaultModel: 'qwen3.7-max' }] });
    if (path === '/api/sessions') return route.fulfill({ json: [session] });
    if (path === `/api${sf.SESSION_PATH}`) return route.fulfill({ json: session });
    if (path === `/api${sf.SESSION_PATH}/events/page`) return route.fulfill({ json: { events, hasMore: false } });
    return route.fallback();
  });
  await page.goto(sf.SESSION_PATH);
  const target = tree === 'after' ? '.chat-quota' : '.chat-error, [class*="chat-err"]';
  await page.locator(target).first().waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  const name = `${tree}-${theme}-${size}`;
  await page.screenshot({ path: `${kit}/shots/${name}.png` });
  boxes[name] = await page.locator(target).first().boundingBox();
  console.log(name, JSON.stringify(boxes[name]), (await page.locator(target).first().innerText()).replace(/\s+/g, ' ').slice(0, 160));
  await page.close();
}

const browser = await chromium.launch({ env: { ...process.env } });
for (const tree of ['before', 'after']) {
  const { server, url } = await serve(`${kit}/${tree}/src/web/dist`);
  for (const theme of ['light', 'dark']) for (const size of ['desktop', 'phone']) await shoot(browser, tree, url, theme, size);
  server.close();
}
writeFileSync(`${kit}/shots/boxes.json`, JSON.stringify(boxes, null, 2));
await browser.close();
