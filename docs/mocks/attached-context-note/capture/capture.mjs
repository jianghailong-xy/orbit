// Real-page frames of the session transcript for the attached-context-note board: the web app built
// from the branch tip (`today`) and from prototype trees (`a`, `b`), served statically from this
// process and fed by src/web/ui-migration's fixtures plus data.mjs. Writes shots/<tree>-<scene>.png
// and shots/boxes.json (element boxes relative to each clip, for the board's numbered marks).
// Usage: node capture.mjs [tree,tree] [scene-prefix]
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { events, cardEvents } from './data.mjs';

const WT = '/root/.orbit/worktrees/01a17c4a-2917-730f-b47a-4da0f9b5cd27';
const KIT = '/var/tmp/attach-note-mock';
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXED_NOW } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, SESSION_PATH } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);

const OUT = `${KIT}/shots`;
mkdirSync(OUT, { recursive: true });
const DISTS = { today: `${KIT}/today-dist`, a: `${KIT}/proto-a-dist`, b: `${KIT}/proto-b-dist`, c: `${KIT}/proto-c-dist`, d: `${KIT}/proto-d-dist`, final: `${KIT}/final-dist` };
const PORTS = {};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function serve(tree) {
  const dir = DISTS[tree];
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let body, type;
      try {
        body = await readFile(join(dir, path));
        type = TYPES[extname(path)] ?? 'application/octet-stream';
      } catch {
        body = await readFile(join(dir, 'index.html'));
        type = 'text/html';
      }
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      PORTS[tree] = server.address().port;
      resolve(server);
    });
  });
}

const session = {
  ...SESSION, title: 'Nightly partition jobs', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN', engineTurnActive: false, lastTurnAt: FIXED_NOW, updatedAt: FIXED_NOW,
  lastAssistantText: events.at(-2).payload.text,
};

async function open(browser, tree, { theme = 'light', width = 1280, height = 1500, phone = false, list = events } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US',
    timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block', hasTouch: phone, isMobile: phone,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  await installFixtures(page, { theme });
  // Registered after the fixtures, so these answer first; anything else falls through to them.
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return route.fallback();
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (p === `/api${SESSION_PATH}`) return json(session);
    if (p === `/api${SESSION_PATH}/events/page`) return json({ events: list, hasMore: false });
    if (p === '/api/sessions') return json([session]);
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORTS[tree]}${SESSION_PATH}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator(list === events ? ':nth-match(.chat-user-wrap, 3)' : '.chat-injected').first().waitFor();
  await page.waitForTimeout(600);
  return { context, page, errors };
}

const rect = (loc) => loc.evaluate((el) => el.getBoundingClientRect().toJSON());

/** The n-th user turn and the answer under it, across the transcript column. */
async function roundClip(page, n, { pad = 14 } = {}) {
  const wrap = page.locator('.chat-user-wrap').nth(n);
  await wrap.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const w = await rect(wrap);
  const answer = page.locator('.chat-user-wrap').nth(n).locator('xpath=following::div[contains(@class,"chat-assistant")][1]');
  const a = await rect(answer);
  const col = await rect(page.locator('.chat-user-wrap').nth(n).locator('xpath=..'));
  const x = Math.min(col.x, a.x) - pad;
  const right = Math.max(w.right, a.right, col.right) + pad;
  const y = w.y - pad;
  const bottom = Math.min(a.bottom, a.y + 120) + pad;
  return { x: Math.max(0, x), y: Math.max(0, y), width: right - Math.max(0, x), height: bottom - Math.max(0, y) };
}

async function boxesIn(page, clip, selectors) {
  const out = {};
  for (const [k, sel] of Object.entries(selectors)) {
    const loc = page.locator(sel).first();
    if (!(await loc.count())) continue;
    const r = await rect(loc);
    out[k] = { x: r.x - clip.x, y: r.y - clip.y, w: r.width, h: r.height };
  }
  return out;
}

async function shoot(page, name, clip, boxes, selectors = {}) {
  const vp = page.viewportSize();
  if (clip.y + clip.height > vp.height) await page.setViewportSize({ width: vp.width, height: Math.ceil(clip.y + clip.height + 20) });
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  boxes[name] = { clip, ...(await boxesIn(page, clip, selectors)) };
}

const noteSel = (n) => ({
  bubble: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-user`,
  note: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected`,
  head: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-head`,
  overview: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-overview`,
  summary: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-summary`,
  para: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-overview p`,
  action: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-action`,
  words: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-user > .md`,
  panel: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-panel`,
  by: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-by`,
  kind: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-kind`,
  facts: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-facts`,
  chevron: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-injected-chevron`,
  meta: `:nth-match(.chat-user-wrap, ${n + 1}) .chat-user-meta`,
});

async function openNote(page, n) {
  // Today's card has its own action; every later tree opens on the line itself, wherever it sits.
  const wrap = page.locator('.chat-user-wrap').nth(n);
  const action = wrap.locator('.chat-injected-action');
  if (await action.count()) await action.click();
  else await wrap.locator('.chat-injected-head').first().click();
  await page.waitForTimeout(250);
}

const SCENES = {
  // The three rounds, folded then opened, at desktop width.
  async desktop(browser, tree, boxes, theme = 'light') {
    const suffix = theme === 'dark' ? '-dark' : '';
    const { context, page, errors } = await open(browser, tree, { theme });
    for (const [n, key] of ['jobs', 'tasks', 'multi'].entries()) {
      if (theme === 'dark' && key !== 'jobs') continue;
      await shoot(page, `${tree}-${key}-folded${suffix}`, await roundClip(page, n), boxes, noteSel(n));
      await openNote(page, n);
      await shoot(page, `${tree}-${key}-open${suffix}`, await roundClip(page, n), boxes, noteSel(n));
    }
    if (errors.length) console.log(tree, 'page errors:', errors);
    await context.close();
  },
  async dark(browser, tree, boxes) {
    await SCENES.desktop(browser, tree, boxes, 'dark');
  },
  // The whole session page, every note folded: what the conversation looks like at a glance.
  async page(browser, tree, boxes) {
    const { context, page } = await open(browser, tree, { height: 900 });
    await page.locator('.chat-user-wrap').nth(0).scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      // The transcript scrolls inside its own pane: the nearest ancestor that can scroll, to its top.
      for (let el = document.querySelector('.chat-user-wrap'); el; el = el.parentElement) {
        const y = getComputedStyle(el).overflowY;
        if ((y === 'auto' || y === 'scroll') && el.scrollHeight > el.clientHeight) {
          el.scrollTop = 0;
          break;
        }
      }
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${tree}-page.png` });
    boxes[`${tree}-page`] = { clip: { x: 0, y: 0, width: 1280, height: 900 } };
    await context.close();
  },
  // The Task started card a run opens with, the wiki's notes at its foot.
  async card(browser, tree, boxes) {
    const { context, page, errors } = await open(browser, tree, { list: cardEvents });
    const card = page.locator('.chat-injected').first().locator('xpath=ancestor::*[contains(@class,"task-start") or contains(@class,"tstart")][1]');
    const target = (await card.count()) ? card : page.locator('.chat-injected').first().locator('xpath=../..');
    const clipOf = async () => {
      const r = await rect(target);
      return { x: r.x - 14, y: r.y - 14, width: r.width + 28, height: r.height + 28 };
    };
    const sel = { note: '.chat-injected', head: '.chat-injected-head', overview: '.chat-injected-overview',
      by: '.chat-injected-by', kind: '.chat-injected-kind', chevron: '.chat-injected-chevron', panel: '.chat-injected-panel' };
    await shoot(page, `${tree}-card-folded`, await clipOf(), boxes, sel);
    const note = page.locator('.chat-injected').first();
    const action = note.locator('.chat-injected-action');
    if (await action.count()) await action.click();
    else await note.locator('.chat-injected-head').click();
    await page.waitForTimeout(400);
    await shoot(page, `${tree}-card-open`, await clipOf(), boxes, sel);
    if (errors.length) console.log(tree, 'page errors:', errors);
    await context.close();
  },
  // A phone-width browser: the bubble is 80% of 390.
  async phone(browser, tree, boxes) {
    const { context, page } = await open(browser, tree, { width: 390, height: 1400, phone: true });
    await shoot(page, `${tree}-phone-jobs-folded`, await roundClip(page, 0, { pad: 8 }), boxes, noteSel(0));
    await openNote(page, 0);
    await shoot(page, `${tree}-phone-jobs-open`, await roundClip(page, 0, { pad: 8 }), boxes, noteSel(0));
    await context.close();
  },
};

const trees = (process.argv[2] ?? 'today,a').split(',');
const only = process.argv[3];
const servers = await Promise.all(trees.map((t) => serve(t)));
const boxesPath = `${OUT}/boxes.json`;
const boxes = existsSync(boxesPath) ? JSON.parse(readFileSync(boxesPath, 'utf8')) : {};
try {
  for (const tree of trees) {
    for (const [key, scene] of Object.entries(SCENES)) {
      if (only && !key.startsWith(only)) continue;
      const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/kimi-accounts-mock/fonts.conf' } });
      try {
        await scene(browser, tree, boxes);
        console.log(tree, key, 'ok');
      } finally {
        await browser.close();
      }
    }
  }
} finally {
  writeFileSync(boxesPath, JSON.stringify(boxes, null, 1));
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}
