// T7 evidence: the real web console (a production build of this worktree, served here) on the boards'
// account (data.mjs), driven through boards 4–8's scenes by clicks, next to the boards rendered by the
// same browser with the same fonts — light and dark. usage: node capture.mjs <dist> <out-dir> [scene…]
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from '/root/.orbit/worktrees/e156eb76-7d94-5654-b980-04356572c73d/node_modules/playwright/index.mjs';
import { FIXTURE_IDS, installFixedDate, installFixtures } from '/root/.orbit/worktrees/e156eb76-7d94-5654-b980-04356572c73d/src/web/ui-migration/fixtures.mjs';
import * as D from './data.mjs';

const [DIST, OUT, ...ONLY] = process.argv.slice(2);
const wants = (name) => ONLY.length === 0 || ONLY.includes(name);
const MOCKS = '/root/.orbit/worktrees/e156eb76-7d94-5654-b980-04356572c73d/docs/mocks/provider-engine-decoupling';
const PORT = 5882;
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

/** The console at `path`, signed in as the fixtures' user, on the boards' account. */
async function open({ theme, path, scenario = 'default', routing = false, width = 1440, height = 1000 }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US',
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  page.setDefaultNavigationTimeout(180_000);
  await installFixedDate(page);
  const fixtures = await installFixtures(page, { theme });
  const sent = [];
  const tasks = new Map([[D.IDS.pinTask, D.pinTask(scenario)], [D.IDS.releaseTask, D.releaseTask()]]);
  // The fixtures' account, with smart model selection on where board 7 needs it.
  const account = {
    id: FIXTURE_IDS.user, name: 'Baseline Reviewer', email: 'reviewer@example.test', createdAt: '2026-09-27T10:00:00.000Z',
    avatarUpdatedAt: null, role: 'MEMBER',
    preferences: { theme, defaultPermissionMode: 'default', notifySessionFinished: true, notifyAgentMessage: true, enableOrchestration: true, modelRouting: routing },
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    let match;
    if (method !== 'GET') {
      sent.push(`${method} ${p} ${request.postData() ?? ''}`);
      if (method === 'PATCH' && (match = /^\/api\/tasks\/([^/]+)$/.exec(p)) && tasks.has(match[1])) {
        Object.assign(tasks.get(match[1]), request.postDataJSON());
        return json(tasks.get(match[1]));
      }
      if (method === 'PATCH' && p === '/api/users/me/preferences') {
        Object.assign(account.preferences, request.postDataJSON());
        return json(account);
      }
      return json({});
    }
    if (p === '/api/users/me') return json(account);
    if (p === '/api/runners') return json([D.HPC]);
    if (p === '/api/workspaces') return json(D.WORKSPACES);
    if (p === '/api/providers') return json(D.providers(scenario));
    if (p === '/api/providers/mine') return json(D.keys(scenario));
    if (p === '/api/providers/pools') return json(D.POOLS);
    if (p === '/api/providers/shared-pools') return json([]);
    if (p === '/api/providers/presets') return json({});
    if (p === '/api/sessions') return json(D.SESSIONS);
    if (p === '/api/sessions/counts') {
      return json(D.WORKSPACES.map((w) => ({ workspaceId: w.id, active: w.id === D.IDS.orbit ? 1 : 0, running: w.id === D.IDS.orbit ? 1 : 0, jobs: 0, needsYou: 0 })));
    }
    if (p === '/api/sessions/imported') return json({ count: 0 });
    if ((match = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(p))) {
      const session = D.SESSIONS.find((s) => s.id === match[1]);
      const sub = match[2] ?? '';
      if (session) {
        if (!sub) return json(session);
        if (sub === '/events/page') return json({ events: D.EVENTS[session.id] ?? [], hasMore: false });
        if (['/turns', '/approvals', '/background'].includes(sub)) return json([]);
        if (sub === '/diff') return json({ files: [], patches: [] });
        if (sub === '/created-tasks') return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      }
    }
    if ((match = /^\/api\/tasks\/([^/]+)$/.exec(p)) && tasks.has(match[1])) return json(tasks.get(match[1]));
    if (p === '/api/tasks/page') {
      const items = [...tasks.values()];
      return json({ items, nextCursor: null, total: items.length, counts: { total: items.length, open: items.length, inProgress: 0, done: 0, failed: 0, cancelled: 0, running: 0, queued: 0, runnable: items.length } });
    }
    if (/^\/api\/runners\/[^/]+\/login$/.test(p)) {
      return json({ status: null, engine: null, url: null, userCode: null, message: null, account: null });
    }
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  const done = async (label) => {
    note(`${label}: page errors ${JSON.stringify(errors)} unanswered ${JSON.stringify([...new Set(fixtures.unhandled)])}`);
    await context.close();
  };
  current = { page, errors, fixtures };
  return { context, page, errors, sent, fixtures, done };
}

/** The page a scene is on, for the picture a failure leaves behind. */
let current = null;
let failures = 0;
/** One scene; a failure is logged with a picture of the page, and the next scene still runs. */
async function scene(name, run) {
  if (!wants(name.split(' ')[0])) return;
  try {
    await run();
  } catch (e) {
    failures++;
    note(`FAILED ${name}: ${e.message.split('\n')[0]}`);
    if (current) {
      note(`  page errors ${JSON.stringify(current.errors)} unanswered ${JSON.stringify([...new Set(current.fixtures.unhandled)])}`);
      await current.page.screenshot({ path: join(OUT, `failed-${name.replace(/\W+/g, '-')}.png`), fullPage: true }).catch(() => {});
      await current.page.context().close().catch(() => {});
    }
  }
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Until nothing is mid-motion: AntD animates its popups whatever reduced-motion says, so wait for every
 *  finite animation to end and for the open popups to stop moving. */
async function still(page) {
  await page.waitForFunction(() => document.getAnimations()
    .every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity));
  const rects = () => page.evaluate(() => JSON.stringify(
    [...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden), .ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden), [role="listbox"]')]
      .map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); })));
  let before = await rects();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const after = await rects();
    if (after === before) break;
    before = after;
  }
  await settle(page);
}

/** Grow the viewport until `height` CSS px (from the top) fits. */
async function fit(page, bottom) {
  const size = page.viewportSize();
  if (bottom + 40 > size.height) {
    await page.setViewportSize({ width: size.width, height: Math.ceil(bottom + 80) });
    await settle(page);
  }
}

/** One element, whole: the viewport grows until the element fits, then the element is shot. */
async function shoot(page, target, file) {
  const el = (typeof target === 'string' ? page.locator(target) : target).first();
  await el.waitFor();
  for (let i = 0; i < 4; i++) {
    const box = await el.boundingBox();
    await fit(page, box.y + box.height);
  }
  await el.scrollIntoViewIfNeeded();
  await settle(page);
  await el.screenshot({ path: join(OUT, file), animations: 'disabled' });
  note(`shot ${file}`);
}

/** The box round several elements, with a margin. */
async function unionBox(page, targets, margin) {
  const boxes = [];
  for (const target of targets) {
    const el = (typeof target === 'string' ? page.locator(target) : target).first();
    await el.waitFor();
    boxes.push(await el.boundingBox());
  }
  return {
    x0: Math.max(0, Math.min(...boxes.map((b) => b.x)) - margin),
    y0: Math.max(0, Math.min(...boxes.map((b) => b.y)) - margin),
    x1: Math.max(...boxes.map((b) => b.x + b.width)) + margin,
    y1: Math.max(...boxes.map((b) => b.y + b.height)) + margin,
  };
}

/** Several elements in one picture: the box round all of them, and a margin of the page around it,
 *  trimmed at the viewport's edge. The viewport grows only when the elements themselves do not fit —
 *  growing it moves what is anchored to its bottom (and away from the pointer a submenu's hover needs),
 *  so the box is measured again after. */
async function shootUnion(page, targets, file, margin = 16) {
  await still(page);
  let box = await unionBox(page, targets, margin);
  if (box.y1 - margin > page.viewportSize().height) {
    await fit(page, box.y1);
    await still(page);
    box = await unionBox(page, targets, margin);
  }
  const { width, height } = page.viewportSize();
  const clip = { x: box.x0, y: box.y0, width: Math.min(box.x1, width) - box.x0, height: Math.min(box.y1, height) - box.y0 };
  await page.screenshot({ path: join(OUT, file), animations: 'disabled', clip });
  note(`shot ${file}`);
}

const visibleMenu = (page) => page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .composer-model-menu');
const providerPopup = (page) => page.locator('.ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden)').filter({ has: page.locator('.ant-dropdown-menu-item-group-title') });
const rowsOf = async (locator) => (await locator.innerText()).split('\n').map((s) => s.trim()).filter(Boolean);

const CHIP = '.composer-model-chip';

/** Every menu closed, by the mouse — a key press would leave the chip with a keyboard focus ring — and
 *  the pointer parked where it hovers nothing. */
async function closeMenus(page) {
  await still(page);
  if (await visibleMenu(page).count()) await page.locator(CHIP).click();
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => !document.querySelector(
    '.ant-dropdown:not(.ant-dropdown-hidden), .ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden)'));
  await still(page);
}

/** The composer's model menu, open (once it says `until`); with `provider`, its Provider level too. */
async function modelMenu(page, { provider = false, until = null } = {}) {
  await closeMenus(page);
  await page.locator(CHIP).click();
  const menu = visibleMenu(page);
  await menu.waitFor();
  if (until) await menu.getByText(until).first().waitFor();
  await still(page);
  if (!provider) return { menu };
  await menu.locator('.ant-dropdown-menu-submenu-title', { hasText: 'Provider' }).hover();
  const popup = providerPopup(page);
  await popup.waitFor();
  await still(page);
  return { menu, popup };
}

/** The hero's engine list, open. */
async function heroList(page) {
  await closeMenus(page);
  const list = page.locator('.np-list');
  if (!(await list.isVisible())) await page.locator('.np-card').click();
  await list.waitFor();
  await settle(page);
  return list;
}

/** The pane round the hero: the hero and the composer under it, as board 4 ① draws the pane. */
async function heroPane(page) {
  await page.evaluate(() => {
    let el = document.querySelector('.np-hero');
    while (el && !el.querySelector('.composer-box')) el = el.parentElement;
    el?.setAttribute('data-shot', 'hero-pane');
  });
  return page.locator('[data-shot="hero-pane"]');
}


for (const theme of ['light', 'dark']) {
  // ── Board 4: a new session on orbit picks the engine, then a provider the engine runs. ──
  await scene(`new ${theme}`, async () => {
    const { page, done } = await open({ theme, path: `/workspaces/${D.IDS.orbit}/new` });
    await page.locator('.np-card').waitFor();
    note(`new ${theme}: lands on ${JSON.stringify(await page.locator('.np-name').innerText())}`);
    let list = await heroList(page);
    await list.locator('.np-row', { hasText: 'DeepSeek Harness' }).click();
    list = await heroList(page);
    note(`new ${theme}: engines ${JSON.stringify(await list.locator('.np-row').allInnerTexts())}`);
    await shoot(page, await heroPane(page), `new-hero-${theme}.png`);
    // ③ DeepSeek Harness: the DeepSeek keys.
    let open1 = await modelMenu(page, { provider: true });
    note(`new ${theme} dsh menu: ${JSON.stringify(await rowsOf(open1.menu))}`);
    note(`new ${theme} dsh providers: ${JSON.stringify(await rowsOf(open1.popup))}`);
    await shootUnion(page, [open1.menu, open1.popup, CHIP], `new-dsh-provider-${theme}.png`);
    // ④ Claude Code on the runner's Default account: the sign-ins, the pool, the keys.
    list = await heroList(page);
    await list.locator('.np-row', { hasText: 'Claude Code' }).click();
    open1 = await modelMenu(page, { provider: true });
    await open1.popup.locator('.composer-account-row-name', { hasText: /^Default$/ }).click();
    open1 = await modelMenu(page, { provider: true });
    note(`new ${theme} claude menu: ${JSON.stringify(await rowsOf(open1.menu))}`);
    note(`new ${theme} claude providers: ${JSON.stringify(await rowsOf(open1.popup))}`);
    await shootUnion(page, [open1.menu, open1.popup, CHIP], `new-claude-provider-${theme}.png`);
    // ⑤ OpenCode: its own sign-in, then every key it runs, and why the subscription token is not there.
    list = await heroList(page);
    await list.locator('.np-row', { hasText: 'OpenCode' }).click();
    open1 = await modelMenu(page, { provider: true });
    note(`new ${theme} opencode menu: ${JSON.stringify(await rowsOf(open1.menu))}`);
    note(`new ${theme} opencode providers: ${JSON.stringify(await rowsOf(open1.popup))}`);
    await shootUnion(page, [open1.menu, open1.popup, CHIP], `new-opencode-provider-${theme}.png`);
    await done(`new ${theme}`);
  });
  // ⑥ No DeepSeek key on the account: DeepSeek Harness's row connects one.
  await scene(`nokey ${theme}`, async () => {
    const { page, done } = await open({ theme, scenario: 'nodeepseek', path: `/workspaces/${D.IDS.orbit}/new` });
    await page.locator('.np-card').waitFor();
    const list = await heroList(page);
    note(`nokey ${theme}: engines ${JSON.stringify(await list.locator('.np-row').allInnerTexts())}`);
    note(`nokey ${theme}: DeepSeek Harness links ${JSON.stringify(await list.locator('a.np-row', { hasText: 'DeepSeek Harness' }).getAttribute('href'))}`);
    await shoot(page, list, `new-nokey-${theme}.png`);
    await done(`nokey ${theme}`);
  });
  // ── Board 5: switching provider in a session moves the credential, never the engine. ──
  await scene(`switch ${theme}`, async () => {
    let { page, done } = await open({ theme, path: `/sessions/${D.IDS.dshSwitch}` });
    await page.locator('.composer-model-chip').waitFor();
    let menu = await modelMenu(page, { provider: true });
    note(`switch ${theme} dsh menu: ${JSON.stringify(await rowsOf(menu.menu))}`);
    note(`switch ${theme} dsh providers: ${JSON.stringify(await rowsOf(menu.popup))}`);
    await shootUnion(page, [menu.menu, menu.popup, CHIP], `switch-dsh-provider-${theme}.png`);
    await menu.popup.locator('.ant-dropdown-menu-item', { hasText: 'DeepSeek 2' }).click();
    await closeMenus(page);
    const noteEl = page.locator('.composer-provider-note');
    await noteEl.waitFor();
    note(`switch ${theme} note: ${JSON.stringify(await noteEl.innerText())}`);
    await shootUnion(page, [noteEl, '.composer-box'], `switch-note-${theme}.png`);
    await done(`switch ${theme} dsh`);

    ({ page, done } = await open({ theme, path: `/sessions/${D.IDS.claudeEnded}` }));
    await page.locator('.composer-model-chip').waitFor();
    menu = await modelMenu(page);
    note(`switch ${theme} claude menu: ${JSON.stringify(await rowsOf(menu.menu))}`);
    await shootUnion(page, [menu.menu, CHIP], `switch-title-${theme}.png`);
    await done(`switch ${theme} claude`);

    ({ page, done } = await open({ theme, path: `/sessions/${D.IDS.dshDeleted}` }));
    await page.locator(CHIP).waitFor();
    menu = await modelMenu(page, { provider: true, until: 'Key deleted' });
    note(`switch ${theme} deleted menu: ${JSON.stringify(await rowsOf(menu.menu))}`);
    note(`switch ${theme} deleted providers: ${JSON.stringify(await rowsOf(menu.popup))}`);
    await shootUnion(page, [menu.menu, menu.popup, CHIP], `switch-deleted-${theme}.png`);
    await done(`switch ${theme} deleted`);
  });
  // ── Board 6: the task pins an engine, then a credential that engine runs. ──
  await scene(`pin ${theme}`, async () => {
    // Tall enough that the panel never scrolls its Details under the sticky task header.
    let { page, sent, done } = await open({ theme, path: `/tasks/${D.IDS.pinTask}`, height: 1500 });
    const details = page.locator('section.tdp-section').filter({ has: page.locator('.tdp-section-title', { hasText: /^Details$/ }) });
    const field = (label) => details.locator('.tdp-field').filter({ has: page.locator('.tdp-field-label', { hasText: new RegExp(`^${label}$`) }) });
    const listbox = page.locator('[role="listbox"]:visible');
    const choose = async (label, option) => {
      await field(label).locator('.tdp-assignee-select').click();
      await listbox.waitFor();
      await still(page);
      if (option) {
        await listbox.locator('[role="option"]', { hasText: option }).first().click();
        await listbox.waitFor({ state: 'hidden' });
        await settle(page);
      }
    };
    await field('Engine').waitFor();
    await page.waitForFunction(() => document.body.innerText.includes("Assignee's · Claude Code"));
    await choose('Engine');
    note(`pin ${theme} engines: ${JSON.stringify(await rowsOf(listbox))}`);
    await shootUnion(page, [details, listbox], `pin-engine-${theme}.png`, 6);
    await listbox.locator('[role="option"]', { hasText: 'DeepSeek Harness' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Engine default · DeepSeek'));
    await choose('Provider');
    note(`pin ${theme} dsh providers: ${JSON.stringify(await rowsOf(listbox))}`);
    await shootUnion(page, [details, listbox], `pin-dsh-provider-${theme}.png`, 6);
    await listbox.locator('[role="option"]', { hasText: 'DeepSeek 2' }).click();
    await listbox.waitFor({ state: 'hidden' });
    await choose('Model', 'DeepSeek V4 Pro');
    await page.waitForFunction(() => document.body.innerText.includes('DeepSeek V4 Pro'));
    // Collapsed as board 6 ③ draws it: no field keeps the focus ring of the last pick.
    await page.evaluate(() => document.activeElement?.blur());
    await still(page);
    note(`pin ${theme} pinned: ${JSON.stringify(await rowsOf(details))}`);
    await shoot(page, details, `pin-collapsed-${theme}.png`);
    // ③ Claude Code runs DeepSeek 2 too, so the credential stays and the model goes.
    await choose('Engine', /^Claude Code$/);
    await page.waitForFunction(() => !document.body.innerText.includes('DeepSeek V4 Pro'));
    note(`pin ${theme} after Claude Code: ${JSON.stringify(await rowsOf(details))}`);
    await choose('Provider', 'Engine default');
    await page.waitForFunction(() => document.body.innerText.includes('Engine default · sign-in on hpc'));
    await choose('Provider');
    note(`pin ${theme} claude providers: ${JSON.stringify(await rowsOf(listbox))}`);
    await shootUnion(page, [details, listbox], `pin-claude-provider-${theme}.png`, 6);
    note(`pin ${theme} writes: ${JSON.stringify(sent)}`);
    await done(`pin ${theme}`);

    ({ page, done } = await open({ theme, scenario: 'migrated', path: `/tasks/${D.IDS.pinTask}`, height: 1500 }));
    const migrated = page.locator('section.tdp-section').filter({ has: page.locator('.tdp-section-title', { hasText: /^Details$/ }) });
    await page.waitForFunction(() => document.body.innerText.includes('DeepSeek Harness'));
    note(`pin ${theme} migrated: ${JSON.stringify(await rowsOf(migrated))}`);
    await shoot(page, migrated, `pin-migrated-${theme}.png`);
    await done(`pin ${theme} migrated`);
  });
  // ── Board 7: a workspace's settings list the engines smart selection may move it to. ──
  await scene(`workspace ${theme}`, async () => {
    const { page, done } = await open({ theme, routing: true, path: `/runners/${D.IDS.hpc}` });
    const row = (name) => page.locator('.rd-workspace-row').filter({ has: page.locator('.rd-workspace-name', { hasText: new RegExp(`^${name}$`) }) });
    await row('orbit').waitFor();
    note(`workspace ${theme} rows: ${JSON.stringify(await page.locator('.rd-workspace-meta').allInnerTexts())}`);
    for (const name of ['orbit', 'builds']) {
      await row(name).click();
      const engines = page.locator('.rd-set-row').filter({ has: page.locator('.rd-route-engines') });
      await engines.waitFor();
      note(`workspace ${theme} ${name}: ${JSON.stringify(await rowsOf(engines))} | ${JSON.stringify(await page.locator('.rd-form-derived').innerText())}`);
      await shootUnion(page, [engines, '.rd-form-derived'], `ws-${name}-${theme}.png`, 12);
      await row(name).click();
      await engines.waitFor({ state: 'hidden' });
    }
    await done(`workspace ${theme}`);
  });
  // ── Board 8: the repair cards name the DeepSeek key. ──
  await scene(`cards ${theme}`, async () => {
    for (const [sessionId, file, selector] of [
      [D.IDS.noKey, 'card-dsh-nokey', '[data-dsh-repair]'],
      [D.IDS.invalidKey, 'card-dsh-invalid', '[data-dsh-repair]'],
      [D.IDS.claudeRejected, 'card-claude-rejected', '.chat-authfix'],
      [D.IDS.neverStarted, 'card-never-started', '[data-run-never-started]'],
    ]) {
      const { page, done } = await open({ theme, path: `/sessions/${sessionId}` });
      const card = page.locator(selector).first();
      await card.waitFor();
      note(`cards ${theme} ${file}: ${JSON.stringify(await rowsOf(card))}`);
      const bubble = page.locator('.chat-user, [data-role="user"]').first();
      await shootUnion(page, (await bubble.count()) ? [bubble, card] : [card], `${file}-${theme}.png`);
      await done(`cards ${theme} ${file}`);
    }
  });
  // ── The boards themselves, rendered here with the same fonts, for the side-by-side. ──
  await scene(`boards ${theme}`, async () => {
    const context = await browser.newContext({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const board = async (file, mark, shots) => {
      await page.goto(`file://${MOCKS}/${file}${theme === 'dark' ? '?theme=dark' : ''}`);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(mark);
      for (const [selector, out] of shots) await shoot(page, selector, out);
    };
    // Each case's "after" column: the second cell after its title (title, now, after, caption).
    await board('web-4-new-session.html', () => {
      document.querySelectorAll('#cases .case').forEach((c, i) => c.nextElementSibling.nextElementSibling.setAttribute('data-shot', `case${i + 1}`));
    }, [
      ['#afterHero', `board-new-hero-${theme}.png`],
      ['[data-shot="case1"]', `board-new-dsh-provider-${theme}.png`],
      ['[data-shot="case2"]', `board-new-claude-provider-${theme}.png`],
      ['[data-shot="case3"]', `board-new-opencode-provider-${theme}.png`],
      ['[data-shot="case4"]', `board-new-nokey-${theme}.png`],
    ]);
    await board('web-5-composer-provider.html', () => {
      document.querySelectorAll('#cases .case').forEach((c, i) => c.nextElementSibling.nextElementSibling.setAttribute('data-shot', `case${i + 1}`));
    }, [
      ['[data-shot="case1"]', `board-switch-dsh-provider-${theme}.png`],
      ['[data-shot="case2"]', `board-switch-note-${theme}.png`],
      ['[data-shot="case3"]', `board-switch-title-${theme}.png`],
      ['[data-shot="case4"]', `board-switch-deleted-${theme}.png`],
    ]);
    await board('web-6-task-pin.html', () => {}, [
      ['#after1', `board-pin-engine-${theme}.png`],
      ['#after2', `board-pin-dsh-provider-${theme}.png`],
      ['#after3', `board-pin-collapsed-${theme}.png`],
      ['#after4', `board-pin-claude-provider-${theme}.png`],
      ['#after5', `board-pin-migrated-${theme}.png`],
    ]);
    // Rows: now, after, now, after.
    await board('web-7-workspace-engines.html', () => {
      const cells = document.querySelectorAll('#rows > div');
      cells[1].setAttribute('data-shot', 'orbit');
      cells[3].setAttribute('data-shot', 'builds');
    }, [
      ['[data-shot="orbit"]', `board-ws-orbit-${theme}.png`],
      ['[data-shot="builds"]', `board-ws-builds-${theme}.png`],
    ]);
    await board('web-8-repair-cards.html', () => {
      document.querySelectorAll('#rows .case').forEach((c, i) => c.nextElementSibling.nextElementSibling.setAttribute('data-shot', `card${i + 1}`));
    }, [
      ['[data-shot="card1"]', `board-card-dsh-nokey-${theme}.png`],
      ['[data-shot="card2"]', `board-card-dsh-invalid-${theme}.png`],
      ['[data-shot="card3"]', `board-card-claude-rejected-${theme}.png`],
    ]);
    await context.close();
  });
}

await browser.close();
server.close();
await writeFile(join(OUT, `capture-log${ONLY.length ? `-${ONLY.join('-')}` : ''}.txt`), `${log.join('\n')}\n`);
if (failures) {
  console.error(`${failures} scene(s) failed`);
  process.exit(1);
}
