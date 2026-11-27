// Real-build shots of the session list's one row shell (components/SessionListRow): plain sessions and
// project rows (a project's coordinator drawn as its session row) side by side, on a desktop and a phone,
// with keyboard focus, right-click, the phone's held press and swipe, a drag onto a folder of each kind,
// and the drag's title card.
//
// Not a test: run by hand against `npm run preview` of a fresh build, with the UI-migration fixtures
// answering every API call and the list, the folders and the move answered here:
//   node src/web/ui-migration/session-row-shell.capture.mjs <outDir> [baseURL] [--native]
// --native also drags with the real pointer (xdotool) in a headed Chromium on $DISPLAY, so the browser's
// own drag image shows, and photographs the screen with ImageMagick's `import` (which leaves the pointer
// out: its arrow is drawn back in at the exact point xdotool put it).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { uuidToBase62 } from '@orbit/shared';
import { installFixtures, installFixedDate } from './fixtures.mjs';
import { SESSION, WORKSPACE } from './session-fixtures.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: session-row-shell.capture.mjs <outDir> [baseURL] [--native]');
const baseURL = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'http://127.0.0.1:4173';
const native = process.argv.includes('--native');
mkdirSync(out, { recursive: true });

const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const folders = [
  { id: id(901), workspaceId: WORKSPACE.id, name: 'Release' },
  { id: id(902), workspaceId: WORKSPACE.id, name: 'Wiki' },
];
const hour = (h) => new Date(Date.parse('2026-09-28T11:30:00.000Z') - h * 3_600_000).toISOString();
const row = (n, title, extra = {}) => ({
  ...SESSION, id: id(n), title, status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  lastTurnAt: hour(n - 100), updatedAt: hour(n - 100), folderId: null, ...extra,
});
const member = (role) => (n, title, project, extra = {}) => row(n, title, {
  projectMembership: { projectId: id(project), projectTitle: `Project ${project}`, projectStatus: 'OPEN', role }, ...extra,
});
const coord = member('COORDINATOR');
const task = member('TASK');
const PIN = '2026-09-28T10:00:00.000Z';
const initialRows = () => [
  { ...SESSION, lastTurnAt: hour(0), folderId: null },
  row(104, 'Pinned plain session', { pinnedAt: PIN }),
  coord(103, 'Pinned launch coordinator', 950, { pinnedAt: PIN }),
  task(105, 'Launch task one', 950),
  coord(102, 'Ops coordinator', 953),
  task(106, 'Ops task one', 953),
  row(101, 'Draft the changelog'),
  row(107, 'Docs in the Release folder', { folderId: folders[0].id }),
  task(108, 'Orphan task of a project with no coordinator', 952),
];

const xdo = (...args) => execFileSync('xdotool', args.map(String));
const log = [];
const note = (line) => { log.push(line); console.log(line); };

/** One browser page on the workspace's list, its API answered by the fixtures and the routes here. */
async function openList(browser, { phone = false, headed = false } = {}) {
  let rows = initialRows();
  const moves = [];
  const context = await browser.newContext({
    ...(headed ? { viewport: null } : phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 760 } }),
    baseURL, locale: 'en-US', timezoneId: 'UTC',
  });
  const page = await context.newPage();
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  // What the drag image was made of: the element handed to setDragImage and the pointer's offset on it.
  await page.addInitScript(() => {
    const set = DataTransfer.prototype.setDragImage;
    DataTransfer.prototype.setDragImage = function (element, x, y) {
      const box = element.getBoundingClientRect();
      window.__dragImage = { className: element.className, text: element.textContent, x, y, width: box.width, height: box.height };
      return set.call(this, element, x, y);
    };
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const method = request.method();
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (method === 'GET' && path === '/api/sessions') return json(rows);
    if (method === 'GET' && path === '/api/session-folders') return json(folders);
    const move = path.match(/^\/api\/sessions\/([^/]+)\/move$/);
    if (method === 'POST' && move) {
      const body = request.postDataJSON();
      moves.push({ sessionId: move[1], body });
      rows = rows.map((r) => (r.id === move[1] ? { ...r, folderId: body.folderId } : r));
      return json({ id: move[1], workspaceId: WORKSPACE.id, folderId: body.folderId });
    }
    return route.fallback();
  });
  await page.goto(phone ? `/workspaces/${WORKSPACE.id}` : `/sessions/${SESSION.id}`);
  await page.locator('#boot').waitFor({ state: 'detached' }).catch(() => page.locator('#boot').waitFor({ state: 'hidden' }));
  await page.locator('.session-project-row').first().waitFor();
  await settle(page, 800);
  return { page, context, moves };
}
const settle = async (page, ms = 400) => {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const sessionRow = (page, title) => page.locator('.session-row:not(.session-project-row)', { has: page.locator('.session-title', { hasText: title }) }).first();
const projectRow = (page, title) => page.locator('.session-project-row', { hasText: title }).first();
const folderRow = (page, name) => page.locator('.session-folder-row', { has: page.locator('.session-folder-name', { hasText: name }) });
const lit = (loc) => loc.evaluate((el) => el.classList.contains('drop-target'));
const selection = (page) => page.evaluate(() => getSelection().toString().replace(/\s+/g, ' ').trim());
const focusedRow = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el?.classList.contains('session-row') ? `${el.classList.contains('session-project-row') ? 'project' : 'session'}: ${el.querySelector('.session-title')?.textContent}` : `${el?.tagName}.${el?.className}`;
});
const menuItems = (page) => page.locator('[role="menuitem"]').allInnerTexts();

const browser = await chromium.launch();

// ── Desktop ──
{
  const { page, context, moves } = await openList(browser);
  const shot = async (name) => { await settle(page); await page.screenshot({ path: `${out}/${name}.png` }); };
  const rowsInfo = await page.locator('.session-col-list .session-row').evaluateAll((els) => els.map((el) =>
    `${el.classList.contains('session-project-row') ? 'project' : 'session'} "${el.querySelector('.session-title')?.textContent}" role=${el.getAttribute('role')} tabindex=${el.getAttribute('tabindex')} draggable=${el.getAttribute('draggable')} kebab="${el.querySelector('.session-kebab')?.getAttribute('aria-label')}"`));
  note(`desktop rows:\n  ${rowsInfo.join('\n  ')}`);
  await shot('desktop-1-list');

  // Keyboard: Tab reaches every row, a project's and a session's; Enter opens the focused one, and ↓ / ↑
  // carry focus with the selection.
  const tabTo = async (want) => {
    await page.locator('.session-col-list').evaluate((el) => el.querySelector('.session-folder-row')?.focus());
    for (let i = 0; i < 30 && (await focusedRow(page)) !== want; i++) await page.keyboard.press('Tab');
    return focusedRow(page);
  };
  note(`keyboard: Tab reached ${await tabTo('project: Project 950')}`);
  await shot('desktop-2-keyboard-focus-project-row');
  note(`keyboard: Tab reached ${await tabTo('session: Draft the changelog')}`);
  await shot('desktop-3-keyboard-focus-session-row');
  await page.keyboard.press('Enter');
  await settle(page);
  note(`keyboard: Enter on the session row -> ${new URL(page.url()).pathname}; focus ${await focusedRow(page)}`);
  await page.keyboard.press('ArrowUp');
  await settle(page);
  note(`keyboard: ArrowUp -> ${new URL(page.url()).pathname}; focus ${await focusedRow(page)}`);
  await shot('desktop-4-keyboard-arrow-carries-focus');
  note(`keyboard: Tab reached ${await tabTo('project: Project 950')}`);
  await page.keyboard.press('Enter');
  await settle(page);
  note(`keyboard: Enter on the project row -> ${new URL(page.url()).pathname}${new URL(page.url()).search}`);
  await shot('desktop-4b-keyboard-enter-project-row-opens-its-page');
  await page.goto(`/sessions/${SESSION.id}`);
  await page.locator('.session-project-row').first().waitFor();
  await settle(page, 600);

  // Right-click: the row's own menu on both kinds.
  await sessionRow(page, 'Pinned plain session').click({ button: 'right' });
  await settle(page);
  note(`right-click session row: menu ${JSON.stringify(await menuItems(page))}`);
  await shot('desktop-5-right-click-session-row');
  await page.keyboard.press('Escape');
  await settle(page);
  await projectRow(page, 'Project 950').click({ button: 'right' });
  await settle(page);
  note(`right-click project row: menu ${JSON.stringify(await menuItems(page))}`);
  await shot('desktop-6-right-click-project-row');
  await page.keyboard.press('Escape');
  await settle(page);

  // Drag (Playwright's own drag events) of each kind onto a folder.
  const dragTo = async (from, to) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.mouse.move(a.x + 60, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 70, a.y + a.height / 2 + 6, { steps: 4 });
    await page.mouse.move(b.x + 80, b.y + b.height / 2, { steps: 12 });
    await settle(page, 250);
  };
  // A press dragged from the coordinator-less project (which is not picked up) selects nothing.
  await dragTo(projectRow(page, 'Project 952'), folderRow(page, 'Wiki'));
  note(`press-drag from the coordinator-less project: selection "${await selection(page)}", Wiki lit=${await lit(folderRow(page, 'Wiki'))}`);
  await shot('desktop-7-no-coordinator-press-drag-selects-nothing');
  await page.mouse.up();
  await settle(page);
  for (const [label, from, folder, toast] of [
    ['project row', projectRow(page, 'Project 950'), 'Wiki', 'Moved to “Wiki”'],
    ['session row', sessionRow(page, 'Pinned plain session'), 'Release', 'Moved to “Release”'],
  ]) {
    await dragTo(from, folderRow(page, folder));
    note(`drag ${label}: ${folder} lit=${await lit(folderRow(page, folder))}, selection "${await selection(page)}", drag image ${JSON.stringify(await page.evaluate(() => window.__dragImage))}`);
    await shot(`desktop-8-drag-${label.replace(' ', '-')}-over-${folder}`);
    await page.mouse.up();
    await page.getByText(toast).waitFor();
    note(`  dropped: ${JSON.stringify(moves.at(-1))}`);
    await settle(page, 3800);
  }
  await context.close();
}

// ── Phone ──
{
  const { page, context } = await openList(browser, { phone: true });
  const shot = async (name) => { await settle(page); await page.screenshot({ path: `${out}/${name}.png` }); };
  await shot('phone-1-list');
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const hold = async (loc) => {
    const box = await loc.boundingBox();
    const x = box.x + 120;
    const y = box.y + box.height / 2;
    await touch('touchStart', x, y);
    await page.waitForTimeout(800);
    await touch('touchEnd', x, y);
    await settle(page);
  };
  const swipe = async (loc, dx) => {
    const box = await loc.boundingBox();
    const x = box.x + (dx > 0 ? 40 : box.width - 40);
    const y = box.y + box.height / 2;
    await touch('touchStart', x, y);
    for (let i = 1; i <= 8; i++) await touch('touchMove', x + (dx * i) / 8, y);
    await touch('touchEnd', x + dx, y);
    await settle(page);
  };
  await hold(projectRow(page, 'Project 950'));
  note(`phone held press on project row: menu ${JSON.stringify(await menuItems(page))}; url ${new URL(page.url()).pathname}`);
  await shot('phone-2-held-press-project-row');
  await page.keyboard.press('Escape');
  await settle(page);
  // A build whose held press opened the row instead: back to the list.
  if (!new URL(page.url()).pathname.startsWith('/workspaces/')) {
    await page.goto(`/workspaces/${WORKSPACE.id}`);
    await page.locator('.session-project-row').first().waitFor();
    await settle(page, 800);
  }
  await hold(sessionRow(page, 'Pinned plain session'));
  note(`phone held press on session row: menu ${JSON.stringify(await menuItems(page))}`);
  await shot('phone-3-held-press-session-row');
  await page.keyboard.press('Escape');
  await settle(page);
  await swipe(projectRow(page, 'Project 953'), 110);
  note(`phone swipe right on project row: ${JSON.stringify(await projectRow(page, 'Project 953').locator('.session-swipe-actions.leading button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label'))))}`);
  await shot('phone-4-swipe-right-project-row');
  // A tap on the open row only closes it.
  { const box = await projectRow(page, 'Project 953').boundingBox(); await page.touchscreen.tap(box.x + 200, box.y + box.height / 2); }
  note(`phone tap on the open row: url ${new URL(page.url()).pathname}`);
  await settle(page);
  await swipe(projectRow(page, 'Project 953'), -110);
  note(`phone swipe left on project row: ${JSON.stringify(await projectRow(page, 'Project 953').locator('.session-swipe-actions.trailing button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label'))))}`);
  await shot('phone-5-swipe-left-project-row');
  await context.close();
}
await browser.close();

// ── Native drag: the browser's own drag image, under the real pointer ──
if (native) {
  const headed = await chromium.launch({ headless: false, args: ['--window-position=0,0', '--window-size=1280,860'] });
  const { page } = await openList(headed, { headed: true });
  const off = await page.evaluate(() => ({ x: window.screenX + (window.outerWidth - window.innerWidth), y: window.screenY + (window.outerHeight - window.innerHeight) }));
  const screen = (x, y) => [Math.round(off.x + x), Math.round(off.y + y)];
  const realDrag = async (from, to, name) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    const start = screen(a.x + a.width / 2, a.y + a.height / 2);
    const end = screen(b.x + 90, b.y + b.height / 2);
    xdo('mousemove', ...start);
    await page.waitForTimeout(150);
    xdo('mousedown', 1);
    for (let i = 1; i <= 20; i++) {
      xdo('mousemove', Math.round(start[0] + ((end[0] - start[0]) * i) / 20), Math.round(start[1] + ((end[1] - start[1]) * i) / 20));
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(500);
    const file = `${out}/${name}.png`;
    execFileSync('import', ['-window', 'root', file]);
    // The pointer, drawn back in where xdotool holds it: a black-edged white arrow, tip at the point.
    const [x, y] = end;
    const arrow = [[0, 0], [0, 17], [4, 13], [7, 20], [10, 19], [7, 12], [12, 12]].map(([dx, dy]) => `${x + dx},${y + dy}`).join(' ');
    execFileSync('convert', [file, '-fill', 'white', '-stroke', 'black', '-strokewidth', '1', '-draw', `polygon ${arrow}`, file]);
    const info = { selection: await selection(page), lit: await page.locator('.session-folder-row.drop-target').allInnerTexts(), image: await page.evaluate(() => window.__dragImage), pointer: end };
    xdo('mouseup', 1);
    await page.waitForTimeout(600);
    return info;
  };
  // A press dragged from the coordinator-less project first: before, it left the list's text selected.
  await realDrag(projectRow(page, 'Project 952'), folderRow(page, 'Wiki'), 'native-0-no-coordinator-press-drag');
  note(`native: after a press-drag on the coordinator-less project, selection "${await selection(page)}"`);
  note(`native: project row over Wiki ${JSON.stringify(await realDrag(projectRow(page, 'Project 950'), folderRow(page, 'Wiki'), 'native-1-project-row-over-wiki'))}`);
  await page.waitForTimeout(3500);
  note(`native: session row over Release ${JSON.stringify(await realDrag(sessionRow(page, 'Draft the changelog'), folderRow(page, 'Release'), 'native-2-session-row-over-release'))}`);
  await headed.close();
}
writeFileSync(`${out}/log.txt`, `${log.join('\n')}\n`);
console.log(`wrote ${out}`);
