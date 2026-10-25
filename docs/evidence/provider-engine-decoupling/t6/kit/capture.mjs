// T6 evidence: the real web console (a production build of this worktree, served here) on the boards'
// account (data.mjs), next to the T0 boards rendered by the same browser with the same fonts — light and
// dark. usage: node capture.mjs <dist> <out-dir>
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from '/root/.orbit/worktrees/bb16742c-7745-5a29-83ab-f4bde58a11b0/node_modules/playwright/index.mjs';
import { installFixedDate, installFixtures } from '/root/.orbit/worktrees/bb16742c-7745-5a29-83ab-f4bde58a11b0/src/web/ui-migration/fixtures.mjs';
import * as D from './data.mjs';

const [DIST, OUT] = process.argv.slice(2);
const MOCKS = '/root/.orbit/worktrees/bb16742c-7745-5a29-83ab-f4bde58a11b0/docs/mocks/provider-engine-decoupling';
const PORT = 5881;
const BASE = `http://127.0.0.1:${PORT}`;
await mkdir(OUT, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let body;
  let type = 'text/html';
  try {
    body = await readFile(join(DIST, path));
    type = TYPES[extname(path)] ?? 'application/octet-stream';
  } catch {
    body = await readFile(join(DIST, 'index.html'));
  }
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/pe-mock/fonts.conf' } });
const log = [];
const note = (line) => { log.push(line); console.log(line); };

/** The console at `path`, signed in as the fixtures' user, on `scenario`'s account. */
async function open({ theme, scenario = 'default', path, expanded = [D.IDS.hpc], width = 1440, height = 1000 }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US',
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  page.setDefaultNavigationTimeout(180_000);
  await installFixedDate(page);
  const fixtures = await installFixtures(page, { theme });
  await page.addInitScript((ids) => localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(ids)), expanded);
  const sent = [];
  const runners = scenario === 'bare' ? D.runners('default').filter((r) => r.name !== 'hpc') : D.runners(scenario);
  const keys = scenario === 'bare' ? [] : scenario === 'onedeepseek' ? D.KEYS.filter((k) => k.label !== 'DeepSeek 2') : D.keys(scenario);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (method !== 'GET') {
      sent.push(`${method} ${p} ${request.postData() ?? ''}`);
      if (method === 'PATCH' && scenario === 'refuse') return json(D.DIALECT_IN_USE, 409);
      return json({});
    }
    if (p === '/api/runners') return json(runners);
    if (p === '/api/providers/mine') return json(keys);
    if (p === '/api/providers/pools') return json(scenario === 'bare' ? [] : D.POOLS);
    if (p === '/api/providers/shared-pools') return json([]);
    if (p === '/api/providers/presets') return json({});
    let match = /^\/api\/providers\/mine\/([^/]+)\/balance$/.exec(p);
    if (match) return json(D.balance(match[1]));
    match = /^\/api\/providers\/mine\/([^/]+)\/usage$/.exec(p);
    if (match) return json(D.usage(match[1]));
    if (/^\/api\/runners\/[^/]+\/login$/.test(p)) {
      return json({ status: null, engine: null, url: null, userCode: null, message: null, account: null });
    }
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, sent, fixtures };
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** One element, whole. The console scrolls inside its own pane, so the viewport grows until the pane
 *  holds the element (a clip past the viewport is trimmed), then the element is shot. */
async function shoot(page, target, file) {
  const el = (typeof target === 'string' ? page.locator(target) : target).first();
  await el.waitFor();
  for (let i = 0; i < 4; i++) {
    const box = await el.boundingBox();
    const size = page.viewportSize();
    const need = Math.ceil(box.height + Math.max(0, box.y) + 120);
    if (need <= size.height) break;
    await page.setViewportSize({ width: size.width, height: need });
    await settle(page);
  }
  await el.scrollIntoViewIfNeeded();
  await settle(page);
  await el.screenshot({ path: join(OUT, file), animations: 'disabled' });
  note(`shot ${file}`);
}

/** A dialog over the page it was opened from: the popup and a margin of the dimmed page round it. */
async function shootDialog(page, dialog, file) {
  await settle(page);
  const box = await dialog.boundingBox();
  const m = 28;
  await page.screenshot({
    path: join(OUT, file), animations: 'disabled',
    clip: { x: Math.max(0, box.x - m), y: Math.max(0, box.y - m), width: box.width + 2 * m, height: box.height + 2 * m },
  });
  note(`shot ${file}`);
}

const text = (page, selector) => page.locator(selector).first().innerText();

for (const theme of ['light', 'dark']) {
  // ① The page, as board 1's after frame draws it: hpc open, old-mac and build-box folded.
  {
    const { context, page, errors, fixtures } = await open({ theme, path: '/infrastructure' });
    await page.waitForFunction(() => document.querySelectorAll('.infra-engine').length === 6
      && document.querySelectorAll('.prov-key').length === 6
      && [...document.querySelectorAll('.dsb-row')].every((row) => row.textContent.includes('¥')), null, { timeout: 180_000 });
    await shoot(page, '.prov-page-head >> xpath=..', `infra-${theme}.png`);
    await shoot(page, '.re-sec:has(.infra-engines)', `infra-overview-${theme}.png`);
    await shoot(page, '#machines', `infra-machines-${theme}.png`);
    await shoot(page, '.provider-keys', `infra-keys-${theme}.png`);
    await shoot(page, '.provider-more', `infra-gallery-${theme}.png`);
    note(`infra ${theme}: cards ${JSON.stringify(await page.locator('.infra-engine-name').allInnerTexts())}`);
    note(`infra ${theme}: errors ${JSON.stringify(errors)} unanswered ${JSON.stringify([...new Set(fixtures.unhandled)])}`);
    // The list's Delete on the first DeepSeek key, as board 3 ② A draws it.
    await page.locator('.prov-key', { hasText: 'Account balance ¥110.00' }).getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('They keep their engine').waitFor();
    await shootDialog(page, dialog, `dialog-delete-${theme}.png`);
    note(`shot dialog-delete-${theme}.png: ${JSON.stringify(await dialog.innerText())}`);
    await context.close();
  }
  // ② Harness on each machine, and the overview with no DeepSeek key and no OpenCode.
  {
    const ids = [D.IDS.hpc, D.IDS.oldMac, D.IDS.buildBox, D.IDS.macStudio];
    const { context, page } = await open({ theme, scenario: 'states', path: '/infrastructure', expanded: ids });
    await page.waitForFunction(() => document.querySelectorAll('.re-row[data-engine="dsh"]').length === 4, null, { timeout: 180_000 });
    for (const name of ['hpc', 'old-mac', 'build-box', 'mac-studio']) {
      const card = page.locator('.re-runner-card').filter({ has: page.locator('.re-runner', { hasText: new RegExp(`^${name}$`) }) });
      await shoot(page, card, `dsh-${name}-${theme}.png`);
      note(`dsh ${name} ${theme}: ${JSON.stringify(await card.locator('.re-row[data-engine="dsh"]').innerText())}`);
    }
    await context.close();
  }
  {
    const { context, page } = await open({ theme, scenario: 'bare', path: '/infrastructure', expanded: [] });
    await page.waitForFunction(() => document.querySelectorAll('.infra-engine').length === 6, null, { timeout: 180_000 });
    await shoot(page, '.infra-engine:has-text("DeepSeek Harness")', `notsetup-dsh-${theme}.png`);
    await shoot(page, '.infra-engine:has-text("OpenCode")', `notsetup-opencode-${theme}.png`);
    note(`notsetup ${theme}: ${JSON.stringify(await page.locator('.infra-engine.none').allInnerTexts())}`);
    await context.close();
  }
  // ③ Connect DeepSeek with one DeepSeek key already there, Advanced open (board 2), via the retired address.
  {
    const { context, page, errors } = await open({ theme, scenario: 'onedeepseek', path: '/providers/new/deepseek-harness', width: 1280 });
    await page.locator('h1', { hasText: 'Connect DeepSeek' }).waitFor();
    note(`connect ${theme}: landed on ${new URL(page.url()).pathname}`);
    await page.locator('.provider-adv-head').click();
    await shoot(page, '.provider-form', `connect-${theme}.png`);
    note(`connect ${theme}: errors ${JSON.stringify(errors)}`);
    await context.close();
  }
  // ④ The key's page (board 3), then Enabled off + Save, then its Delete key.
  {
    const { context, page, sent } = await open({ theme, path: `/providers/${D.IDS.deepseek}`, width: 1280 });
    await page.getByText('2 open sessions').waitFor();
    await page.locator('.dsb-total, .dsb-card').first().waitFor();
    await shoot(page, '.provider-form', `edit-${theme}.png`);
    await page.getByRole('switch', { name: 'Enabled' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('nothing falls back').waitFor();
    await shootDialog(page, dialog, `dialog-turnoff-${theme}.png`);
    note(`shot dialog-turnoff-${theme}.png: ${JSON.stringify(await dialog.innerText())}`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    note(`edit ${theme}: writes after Cancel ${JSON.stringify(sent)}`);
    await context.close();
  }
  // ⑤ An endpoint change the server refuses while sessions use the key (board 3 ③).
  {
    const { context, page } = await open({ theme, scenario: 'refuse', path: `/providers/${D.IDS.deepseek}`, width: 1280 });
    await page.locator('.provider-adv-head').click();
    const endpoint = page.locator('.provider-adv-body input').first();
    await endpoint.fill('https://api.example.com/v1/responses');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.provider-save-error').waitFor();
    await shoot(page, '.provider-form', `refused-${theme}.png`);
    note(`refused ${theme}: ${JSON.stringify(await text(page, '.provider-save-error'))}`);
    await context.close();
  }
  // The boards themselves, rendered here with the same fonts, for the side-by-side.
  {
    const context = await browser.newContext({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const board = async (file, shots) => {
      await page.goto(`file://${MOCKS}/${file}${theme === 'dark' ? '?theme=dark' : ''}`);
      await page.evaluate(() => document.fonts.ready);
      for (const [selector, out] of shots) await shoot(page, selector, out);
    };
    await board('web-1-infrastructure.html', [
      ['#after', `board-infra-${theme}.png`],
      ['#after .re-sec:has(.infra-engines)', `board-infra-overview-${theme}.png`],
      ['#after .re-sec:has(.re-runner-card)', `board-infra-machines-${theme}.png`],
      ['#after .provider-keys', `board-infra-keys-${theme}.png`],
      ['#after .provider-more', `board-infra-gallery-${theme}.png`],
      ['#states', `board-dsh-states-${theme}.png`],
    ]);
    await board('web-2-deepseek-connect.html', [['#after', `board-connect-${theme}.png`]]);
    await board('web-3-deepseek-key.html', [
      ['#after', `board-edit-${theme}.png`],
      ['#ab .ab-opt.rec', `board-dialogs-${theme}.png`],
      ['#edit', `board-refused-${theme}.png`],
    ]);
    await context.close();
  }
}

await browser.close();
server.close();
await writeFile(join(OUT, 'capture-log.txt'), `${log.join('\n')}\n`);
