// Real-page frames for docs/mocks/composer-sending-bubble: the web app built before the change
// (`today`, 1a4b20265a) and after it (`after`, this branch), served from this process and fed by
// src/web/ui-migration's fixtures. The send's POST is held, accepted or refused per scene.
// Writes shots/<scene>.png. Usage: node capture.mjs [scene,scene]
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const WT = '/root/.orbit/worktrees/01a21af9-8392-702c-9ed9-8303a2813b27';
const KIT = '/var/tmp/sending-bubble-mock';
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION_PATH, WORKSPACE } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);

const OUT = `${KIT}/shots`;
mkdirSync(OUT, { recursive: true });
const DISTS = { today: `${KIT}/today-dist`, after: `${KIT}/after-dist` };
const PORTS = {};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
const WORDS = "Check the cluster's state and load every half hour.\nIf anything looks wrong, compare it against the code in ws analytics.";
const NEXT = 'Also post a short summary to the channel';
const REFUSED = 'Restore this session to Open before sending a message';

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
    server.listen(0, '127.0.0.1', () => { PORTS[tree] = server.address().port; resolve(server); });
  });
}

/** `send`: 'hold' (never answered until released), or a function answering the route. */
async function open(browser, tree, path = SESSION_PATH) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US',
    timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  const held = [];
  const control = { mode: 'hold', held };
  await page.route(`**/api${SESSION_PATH}/turns/current-work-routing`, async (route) => {
    if (control.mode === 'refuse') return route.fulfill({ status: 400, json: { message: REFUSED } });
    held.push(route); // answered (or abandoned) by the scene
  });
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (control.mode === 'refuse') return route.fulfill({ status: 503, json: { message: 'The control plane is restarting' } });
    held.push(route);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORTS[tree]}${path}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  if (path === SESSION_PATH) await page.locator('.chat-assistant').first().waitFor();
  await page.locator('.composer-field textarea').waitFor();
  await page.waitForTimeout(500);
  return { context, page, errors, control };
}

const rect = (loc) => loc.evaluate((el) => el.getBoundingClientRect().toJSON());

async function typeIn(page, words) {
  const box = page.locator('.composer-field textarea');
  await box.click();
  await box.fill(words);
}

async function shoot(page, name) {
  const comp = await rect(page.locator('.workspace-composer'));
  const top = page.locator('.chat-assistant').first();
  const firstAssistant = (await top.count()) ? await rect(top) : { y: (await rect(page.locator('.workspace-scroll-wrap'))).y + 16 };
  const x = comp.x - 16, right = comp.right + 16;
  const y = Math.max(0, firstAssistant.y - 16), bottom = comp.bottom + 12;
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x, y, width: right - x, height: bottom - y } });
}

const hoverFoot = async (page) => {
  await page.locator('.chat-undelivered').last().hover();
  await page.waitForTimeout(1600);
};

const NEW_PATH = `/workspaces/${WORKSPACE.id}/new`;
const SCENES = {
  async newBefore(browser) {
    const { context, page, errors } = await open(browser, 'after', NEW_PATH);
    await typeIn(page, WORDS);
    await page.mouse.move(5, 5);
    await shoot(page, 'new-before');
    await context.close();
    return errors;
  },
  async newToday(browser) {
    const { context, page, errors } = await open(browser, 'today', NEW_PATH);
    await typeIn(page, WORDS);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.mouse.move(5, 5);
    await shoot(page, 'new-today');
    await context.close();
    return errors;
  },
  async newSending(browser) {
    const { context, page, errors } = await open(browser, 'after', NEW_PATH);
    await typeIn(page, WORDS);
    await page.keyboard.press('Enter');
    await page.locator('.chat-sending').waitFor();
    await page.waitForTimeout(400);
    await page.mouse.move(5, 5);
    await shoot(page, 'new-sending');
    await context.close();
    return errors;
  },
  async newRefused(browser) {
    const { context, page, errors, control } = await open(browser, 'after', NEW_PATH);
    control.mode = 'refuse';
    await typeIn(page, WORDS);
    await page.keyboard.press('Enter');
    await page.locator('.chat-undelivered').waitFor();
    await hoverFoot(page);
    await shoot(page, 'new-refused');
    await context.close();
    return errors;
  },
  async today(browser) {
    const { context, page, errors } = await open(browser, 'today');
    await typeIn(page, WORDS);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.mouse.move(5, 5);
    await shoot(page, 'today');
    await context.close();
    return errors;
  },
  async sending(browser) {
    const { context, page, errors } = await open(browser, 'after');
    await typeIn(page, WORDS);
    await page.keyboard.press('Enter');
    await page.locator('.chat-sending').waitFor();
    await page.waitForTimeout(400);
    await page.mouse.move(5, 5);
    await shoot(page, 'sending');
    await context.close();
    return errors;
  },
  async sent(browser) {
    const { context, page, errors, control } = await open(browser, 'after');
    await typeIn(page, WORDS);
    await page.keyboard.press('Enter');
    await page.locator('.chat-sending').waitFor();
    await typeIn(page, NEXT);
    await control.held[0].fulfill({ status: 200, json: { turnId: 'turnSent0000000000000a', seq: 4, kind: 'message', placement: 'accepted' } });
    await page.locator('.chat-sending').waitFor({ state: 'detached' });
    await page.waitForTimeout(500);
    await page.mouse.move(5, 5);
    await shoot(page, 'sent');
    await context.close();
    return errors;
  },
  async notAnswered(browser) {
    const { context, page, errors } = await open(browser, 'after');
    await typeIn(page, WORDS);
    await page.keyboard.press('Enter');
    await page.locator('.chat-undelivered').waitFor({ timeout: 30000 });
    await hoverFoot(page);
    await shoot(page, 'not-answered');
    await context.close();
    return errors;
  },
  async refused(browser) {
    const { context, page, errors, control } = await open(browser, 'after');
    control.mode = 'refuse';
    await typeIn(page, WORDS);
    await page.keyboard.press('Enter');
    await page.locator('.chat-undelivered').waitFor();
    await hoverFoot(page);
    await shoot(page, 'refused');
    await context.close();
    return errors;
  },
};

const wanted = process.argv[2]?.split(',') ?? Object.keys(SCENES);
const servers = await Promise.all(Object.keys(DISTS).map(serve));
const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'], env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/save-error-mock/fonts.conf' } });
for (const name of wanted) {
  const errors = await SCENES[name](browser);
  console.log(name, errors.length ? errors : 'ok');
}
await browser.close();
servers.forEach((s) => s.close());
