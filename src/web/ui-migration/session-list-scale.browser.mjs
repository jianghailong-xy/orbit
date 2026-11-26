import { test, expect } from '@playwright/test';
import { uuidToBase62 } from '@orbit/shared';
import { installFixtures, installFixedDate, FIXED_NOW } from './fixtures.mjs';
import { RUNNER, WORKSPACE } from './session-fixtures.mjs';
import { answerListing } from './session-listing-fixtures.mjs';

// The session column windowed (docs/session-list-scale-design.md §4), on the production build with the
// UI-migration fixtures answering every call and a seeded list answered here: 1,500 Open sessions in a
// workspace with folders (read from GET /sessions/listing a page of entries at a time, as a workspace with
// folders is, answered by the server's own rules), and 1,500 in one without (read a page of GET /sessions
// at a time). What it shows: the column mounts about two screens of rows; ↑ / ↓ walk past the
// viewport; a row dragged from deep in the list reaches a folder; scrolling to the end reads the next
// page; a watch or clone frame commits the one row it is about; and, on a phone, a row still swipes and
// takes a held press, and the list is where it was after a conversation.

const SEEDED = 1500;
const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const PAGED = { ...WORKSPACE, id: id(21), name: 'Paged workspace' };
const FOLDERS = [
  { id: id(901), workspaceId: WORKSPACE.id, name: 'Release' },
  { id: id(902), workspaceId: WORKSPACE.id, name: 'Wiki' },
];
const minutesAgo = (m) => new Date(Date.parse(FIXED_NOW) - m * 60_000).toISOString();
const pad = (n) => String(n).padStart(4, '0');
const seed = (n, workspace, title, extra = {}) => ({
  id: id(100_000 + (workspace === WORKSPACE ? 0 : 10_000) + n),
  workspaceId: workspace.id, workspace, runnerId: RUNNER.id, assignedRunnerId: RUNNER.id,
  title, provider: 'claude', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
  createdAt: minutesAgo(n), updatedAt: minutesAgo(n), startedAt: minutesAgo(n), engineStartedAt: minutesAgo(n),
  lastTurnAt: minutesAgo(n), listedAt: minutesAgo(n), lastAssistantText: `Reply ${pad(n)}`, folderId: null, shareToken: null,
  ...extra,
});
// Seeds 1–10 are filed in Release (one waits on you), 11–20 in Wiki; 21 on are the list's own rows, newest first.
// Seed 23 is held by its workspace's clone, which a clone frame moves.
const seededRows = () => Array.from({ length: SEEDED }, (_, i) => {
  const n = i + 1;
  const extra = n <= 10 ? { folderId: FOLDERS[0].id } : n <= 20 ? { folderId: FOLDERS[1].id } : {};
  if (n === 3) Object.assign(extra, { pendingApprovals: 1, waitingKind: 'OWNER_ITEM' });
  if (n === 23) Object.assign(extra, { status: 'QUEUED', runState: 'QUEUED', queuedReason: 'WORKSPACE_CLONING' });
  return seed(n, WORKSPACE, `Seeded session ${pad(n)}`, extra);
});
const pagedRows = () => Array.from({ length: SEEDED }, (_, i) => seed(i + 1, PAGED, `Paged session ${pad(i + 1)}`));
const title = (n) => `Seeded session ${pad(n)}`;

/** session_await's watch on seed 22, as GET /watches answers it. */
const watchOn = (observer, target) => ({
  id: 'watch-scale-1', observerType: 'SESSION', observerSessionId: observer.id, predicateVersion: 1,
  predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
  mode: 'ONE_SHOT', action: 'RESUME_SESSION', state: 'ACTIVE', generation: 0,
  expiresAt: '2026-09-29T12:00:00Z', nextEvaluateAt: FIXED_NOW, lastEvaluatedAt: FIXED_NOW, idempotencyKey: null,
  createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  targets: [{ targetKind: 'SESSION', targetResourceId: target.id, state: 'OBSERVED', targetEpoch: 0, lastEvaluatedAt: FIXED_NOW,
    targetTitle: target.title, targetStatus: { status: 'RUNNING', running: true, queued: false } }],
  matches: [], expiryDeliveries: [],
});

/** Answers the seeded lists, their sessions, the folders, a move and the watches; everything else falls to
 *  the UI-migration fixtures. */
async function seedList(page, { theme }) {
  await installFixedDate(page);
  await installFixtures(page, { theme });
  const state = { rows: seededRows(), paged: pagedRows(), moves: [], listReads: [], listingReads: [], watches: [] };
  const byId = () => new Map([...state.rows, ...state.paged].map((row) => [row.id, row]));
  // Registered after installFixtures, so these answer first.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (method === 'GET' && path === '/api/workspaces') return json([WORKSPACE, PAGED]);
    if (method === 'GET' && path === '/api/session-folders') return json(FOLDERS);
    // No open project: a workspace with no folders is then read a page at a time.
    if (method === 'GET' && path === '/api/projects/sidebar') return json([]);
    if (method === 'GET' && path === '/api/watches') return json(state.watches);
    if (method === 'GET' && path === '/api/sessions') {
      const q = url.searchParams;
      state.listReads.push(Object.fromEntries(q));
      if (q.get('scheduled') || (q.get('view') && q.get('view') !== 'open')) return json([]);
      const workspaceId = q.get('workspaceId');
      const rows = workspaceId === PAGED.id ? state.paged : workspaceId === WORKSPACE.id ? state.rows : [...state.rows, ...state.paged];
      const limit = Number(q.get('limit') || 0);
      return json(limit ? rows.slice(0, limit) : rows);
    }
    if (method === 'GET' && path === '/api/sessions/listing') {
      const answer = answerListing([...state.rows, ...state.paged], FOLDERS, url.searchParams);
      state.listingReads.push({ query: Object.fromEntries(url.searchParams), next: answer.next });
      return json(answer);
    }
    const move = path.match(/^\/api\/sessions\/([^/]+)\/move$/);
    if (method === 'POST' && move) {
      const body = request.postDataJSON();
      state.moves.push({ sessionId: move[1], folderId: body.folderId });
      state.rows = state.rows.map((row) => (row.id === move[1] ? { ...row, folderId: body.folderId } : row));
      return json({ id: move[1], workspaceId: WORKSPACE.id, folderId: body.folderId });
    }
    const one = path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (method === 'GET' && one && byId().has(one[1])) {
      const suffix = one[2] ?? '';
      if (!suffix) return json(byId().get(one[1]));
      if (suffix === '/events/page') return json({ events: [], hasMore: false });
      if (['/turns', '/approvals', '/background'].includes(suffix)) return json([]);
      if (suffix === '/diff') return json({ files: [], patches: [] });
      if (suffix === '/created-tasks') return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
    }
    return route.fallback();
  });
  return state;
}

const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => {
  const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
  step(count);
}), n);
const list = (page) => page.locator('.session-col-list').first();
const row = (page, text) => page.locator('.session-list-window .session-row', { has: page.locator('.session-title', { hasText: text }) });
const folderRow = (page, name) => page.locator('.session-folder-row', { has: page.locator('.session-folder-name', { hasText: name }) });
/** How many session rows the column has mounted, and how many fit its viewport. */
const mounted = (page) => list(page).evaluate((el) => ({
  rows: el.querySelectorAll('.session-list-window .session-row').length,
  allRows: document.querySelectorAll('.session-row').length,
  height: el.clientHeight,
  scrollHeight: el.scrollHeight,
  scrollTop: el.scrollTop,
}));
/** At most about two screens of rows: the viewport's worth twice over, a row of 64px being the shortest. */
const twoScreens = (height) => 2 * Math.ceil(height / 64) + 2;
const scrollListTo = async (page, top) => {
  await list(page).evaluate((el, to) => { el.scrollTop = to; }, top);
  await frames(page, 4);
};
const inView = (page, locator) => locator.evaluate((el) => {
  const box = el.getBoundingClientRect();
  const view = el.closest('.session-col-list').getBoundingClientRect();
  return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
});

/** Scrolls the column to its end until the listing has read `pages` pages (all of them when omitted): it
 *  reads the next one as the last rows come into view. */
async function loadPages(page, state, pages = Infinity) {
  const read = () => state.listingReads.filter((r) => r.query.workspaceId === WORKSPACE.id && !r.query.folderId);
  await expect.poll(() => read().length).toBeGreaterThan(0);
  while (read().length < pages && read().at(-1).next) {
    const before = read().length;
    await scrollListTo(page, 10_000_000);
    await expect.poll(() => read().length).toBeGreaterThan(before);
  }
  await frames(page, 4);
}

const desktop = (testInfo) => test.skip(!testInfo.project.name.endsWith('-desktop'), 'a desktop case');
const phone = (testInfo) => test.skip(!testInfo.project.name.endsWith('-phone'), 'a phone case');

test('1,500 loaded Open sessions mount about two screens of rows, wherever the column is scrolled', async ({ page }, testInfo) => {
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(testInfo.project.name.endsWith('-phone') ? `/workspaces/${WORKSPACE.id}` : `/sessions/${seededRows()[20].id}`);
  await expect(row(page, title(21))).toBeVisible();
  await expect(folderRow(page, 'Release')).toBeVisible();
  // The folder row still reads the sessions filed in it: one of Release's waits on you.
  await expect(folderRow(page, 'Release').locator('.session-folder-needs')).toHaveText('1');
  // Every page of the listing, read as the column is scrolled to its end, then back to the top.
  await loadPages(page, state);
  await scrollListTo(page, 0);
  const top = await mounted(page);
  await testInfo.attach('mounted at the top', { body: JSON.stringify(top), contentType: 'application/json' });
  // The column is as tall as 1,480 rows (the other 20 are in folders), and only a few are mounted.
  expect(top.scrollHeight).toBeGreaterThan(1480 * 60);
  expect(top.rows).toBeGreaterThan(Math.ceil(top.height / 80));
  expect(top.rows).toBeLessThanOrEqual(twoScreens(top.height));
  for (const fraction of [0.25, 0.5, 0.999]) {
    await scrollListTo(page, Math.round(top.scrollHeight * fraction));
    const deep = await mounted(page);
    await testInfo.attach(`mounted at ${fraction}`, { body: JSON.stringify(deep), contentType: 'application/json' });
    expect(deep.rows, `rows mounted at ${fraction} of the list`).toBeLessThanOrEqual(twoScreens(deep.height));
    expect(deep.allRows, `rows in the page at ${fraction} of the list`).toBeLessThan(120);
  }
  // The last row is drawn at the end.
  await expect(row(page, title(SEEDED))).toBeVisible();
});

test('↓ and ↑ walk the open session past the viewport, the row scrolled in and focused', async ({ page }, testInfo) => {
  desktop(testInfo);
  await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/sessions/${seededRows()[20].id}`);
  await row(page, title(21)).focus();
  await expect(row(page, title(21))).toBeFocused();
  const steps = 60;
  // Each step waits for the row it opened to be drawn as the open one: the list's ↑ / ↓ handler is the one
  // of the render that drew it, so a key pressed sooner would step from the row before.
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(new RegExp(`/sessions/${seededRows()[21 + i].id}`));
    await expect(row(page, title(22 + i))).toHaveClass(/active/);
    await frames(page, 1);
  }
  const target = row(page, title(21 + steps));
  await expect(target).toHaveClass(/active/);
  await expect(target).toBeFocused();
  expect(await inView(page, target)).toBe(true);
  // The first rows are far above by now, and unmounted.
  await expect(row(page, title(21))).toHaveCount(0);
  for (let i = steps - 1; i >= 0; i -= 1) {
    await page.keyboard.press('ArrowUp');
    await expect(row(page, title(21 + i))).toHaveClass(/active/);
    await frames(page, 1);
  }
  await expect(page).toHaveURL(new RegExp(`/sessions/${seededRows()[20].id}`));
  await expect(row(page, title(21))).toBeFocused();
  expect(await inView(page, row(page, title(21)))).toBe(true);
});

test('a row dragged from deep in the list scrolls the column up and drops onto a folder row', async ({ page }, testInfo) => {
  desktop(testInfo);
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/sessions/${seededRows()[20].id}`);
  await expect(folderRow(page, 'Release')).toBeVisible();
  // Rows 21–140: the listing's first three pages.
  await loadPages(page, state, 3);
  await scrollListTo(page, 64 * 60);
  await expect(folderRow(page, 'Release')).toHaveCount(0);
  const dragged = row(page, title(90));
  await dragged.scrollIntoViewIfNeeded();
  await frames(page, 4);
  const box = await list(page).boundingBox();
  const from = await dragged.boundingBox();
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 70, from.y + from.height / 2 - 6, { steps: 4 });
  // Held at the column's top edge, the drag scrolls it up to the folders.
  await page.mouse.move(box.x + 120, box.y + 6, { steps: 10 });
  for (let i = 0; i < 400 && (await list(page).evaluate((el) => el.scrollTop)) > 0; i += 1) {
    await page.mouse.move(box.x + 120 + (i % 2), box.y + 6);
    await page.waitForTimeout(30);
  }
  expect(await list(page).evaluate((el) => el.scrollTop)).toBe(0);
  // The row being dragged stays mounted while it is far off screen: its drag ends on it.
  expect(await page.locator('.session-row.dragging .session-title').textContent()).toBe(title(90));
  const release = await folderRow(page, 'Release').boundingBox();
  await page.mouse.move(box.x + 120, box.y + 200, { steps: 4 });
  await page.mouse.move(release.x + 80, release.y + release.height / 2, { steps: 8 });
  await expect(folderRow(page, 'Release')).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(page.getByText('Moved to “Release”')).toBeVisible();
  expect(state.moves).toEqual([{ sessionId: seededRows()[89].id, folderId: FOLDERS[0].id }]);
  await expect(page.locator('.session-row.dragging')).toHaveCount(0);
});

test('scrolling to the end of a paged list reads the next page', async ({ page }, testInfo) => {
  desktop(testInfo);
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/workspaces/${PAGED.id}`);
  await expect(row(page, 'Paged session 0001')).toBeVisible();
  const limits = () => state.listReads.filter((q) => q.workspaceId === PAGED.id && !q.scheduled).map((q) => Number(q.limit || 0));
  expect(Math.max(...limits())).toBe(40);
  await scrollListTo(page, 1_000_000);
  await expect.poll(() => Math.max(...limits())).toBe(80);
  await scrollListTo(page, 1_000_000);
  await expect(row(page, 'Paged session 0080')).toBeVisible();
  await expect.poll(() => Math.max(...limits())).toBe(120);
  const after = await mounted(page);
  expect(after.rows).toBeLessThanOrEqual(twoScreens(after.height));
});

test('a watch frame and a clone frame each commit the one row they are about', async ({ page }, testInfo) => {
  desktop(testInfo);
  // A render-count probe: React's DevTools hook sees every commit; a mounted row's element gets new props
  // exactly when its SessionListRow rendered again.
  await page.addInitScript(() => {
    const seen = new WeakMap();
    const probe = { armed: false, rendered: [], commits: 0 };
    window.__rowProbe = probe;
    let renderers = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, isDisabled: false, renderers: new Map(),
      inject(renderer) { renderers += 1; this.renderers.set(renderers, renderer); return renderers; },
      checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id, root) {
        const stack = [root.current];
        while (stack.length) {
          const fiber = stack.pop();
          const el = fiber.stateNode;
          if (fiber.tag === 5 && el?.classList?.contains('session-row') && el.closest?.('.session-list-window')) {
            const before = seen.get(el);
            if (before !== fiber.memoizedProps) {
              if (before !== undefined && probe.armed) probe.rendered.push(el.querySelector('.session-title')?.textContent ?? '?');
              seen.set(el, fiber.memoizedProps);
            }
          }
          if (fiber.sibling) stack.push(fiber.sibling);
          if (fiber.child) stack.push(fiber.child);
        }
        if (probe.armed) probe.commits += 1;
      },
    };
  });
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  const rows = seededRows();
  await page.goto(`/sessions/${rows[20].id}`);
  await expect(row(page, title(22))).toBeVisible();
  await expect(row(page, title(30))).toBeVisible();
  await page.waitForFunction(() => window.__uiMigrationStreams?.some((s) => s.readyState === 1 && new URL(s.url).pathname === '/api/events'));
  const emit = (frame) => page.evaluate((f) => {
    const stream = window.__uiMigrationStreams.findLast((s) => s.readyState === 1 && new URL(s.url).pathname === '/api/events');
    stream.emit(f);
  }, frame);
  const arm = () => page.evaluate(() => { window.__rowProbe.armed = true; window.__rowProbe.rendered = []; window.__rowProbe.commits = 0; });
  const read = () => page.evaluate(() => ({ ...window.__rowProbe }));
  // Settle: whatever the first reads still redraw happens before the probe counts.
  await page.waitForTimeout(1500);

  // A watch frame: seed 22 is now waiting on a watch, and its line says so.
  await arm();
  state.watches = [watchOn(rows[21], rows[40])];
  await emit({ type: 'watch.changed', data: { id: 'watch-scale-1' } });
  await expect(row(page, title(22)).locator('.session-preview')).toContainText('Watching');
  await page.waitForTimeout(500);
  const watchFrame = await read();
  await testInfo.attach('watch frame', { body: JSON.stringify(watchFrame), contentType: 'application/json' });
  expect(watchFrame.commits).toBeGreaterThan(0);
  expect([...new Set(watchFrame.rendered)]).toEqual([title(22)]);

  // A clone frame: the first names the clone's state (which reads the workspace's sessions again); the next
  // moves its percentage alone, and redraws seed 23's row, held by the clone.
  await emit({ type: 'workspace.changed', data: { id: WORKSPACE.id, clone: { state: 'CLONING', progress: 10 } } });
  await expect(row(page, title(23)).locator('.session-preview')).toHaveText('Cloning · 10%');
  await page.waitForTimeout(1500);
  await arm();
  await emit({ type: 'workspace.changed', data: { id: WORKSPACE.id, clone: { state: 'CLONING', progress: 11 } } });
  await expect(row(page, title(23)).locator('.session-preview')).toHaveText('Cloning · 11%');
  await page.waitForTimeout(500);
  const cloneFrame = await read();
  await testInfo.attach('clone frame', { body: JSON.stringify(cloneFrame), contentType: 'application/json' });
  expect(cloneFrame.commits).toBeGreaterThan(0);
  expect([...new Set(cloneFrame.rendered)]).toEqual([title(23)]);
});

/** A finger on a row of the phone's list: touch events at a point of the row, as the browser sends them. */
function touch(page, target) {
  const send = (type, x, y) => target.evaluate((el, [kind, cx, cy]) => {
    const point = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy });
    const touches = kind === 'touchend' ? [] : [point];
    el.dispatchEvent(new TouchEvent(kind, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: [point] }));
  }, [type, x, y]);
  return {
    swipe: async (x, y, dx) => {
      await send('touchstart', x, y);
      for (let i = 1; i <= 10; i += 1) {
        await send('touchmove', x + (dx * i) / 10, y);
        await frames(page, 1);
      }
      await send('touchend', x + dx, y);
    },
    hold: async (x, y, ms) => {
      await send('touchstart', x, y);
      await page.waitForTimeout(ms);
      await send('touchend', x, y);
    },
  };
}

test('on a phone, a row deep in the list swipes and takes a held press, and the list comes back where it was', async ({ page }, testInfo) => {
  phone(testInfo);
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/workspaces/${WORKSPACE.id}`);
  await expect(row(page, title(21))).toBeVisible();
  // Deep in the list: the listing's first six pages, rows 21–260.
  await loadPages(page, state, 6);
  await scrollListTo(page, 64 * 200);
  const before = await mounted(page);
  expect(before.rows).toBeLessThanOrEqual(twoScreens(before.height));
  const pickedTitle = await page.locator('.session-list-window .session-row').filter({ visible: true }).nth(3)
    .locator('.session-title').textContent();
  const picked = row(page, pickedTitle);
  const finger = touch(page, picked.locator('.session-swipe'));

  // A leftward swipe opens the row's trailing actions.
  let box = await picked.boundingBox();
  await finger.swipe(box.x + box.width - 40, box.y + box.height / 2, -160);
  await expect.poll(() => picked.locator('.session-swipe-actions.trailing').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(40);
  // A tap shuts it again.
  await picked.locator('.session-title').tap();
  await expect.poll(() => picked.locator('.session-swipe-actions.trailing').evaluate((el) => el.getBoundingClientRect().width)).toBe(0);

  // A held press opens the row's menu where the finger is.
  box = await picked.boundingBox();
  await finger.hold(box.x + 80, box.y + box.height / 2, 800);
  await expect(page.locator('.session-press-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.session-press-menu')).toHaveCount(0);

  // Into the conversation and back: the list is where it was.
  const top = (await mounted(page)).scrollTop;
  await picked.locator('.session-title').tap();
  await expect(page.locator('.workspace-split.show-conversation')).toHaveCount(1);
  // The hidden list keeps the rows it drew, and draws no more for its height of 0.
  expect(await page.locator('.session-list-window .session-row').count()).toBeLessThanOrEqual(twoScreens(before.height));
  await page.goBack();
  await expect(page.locator('.workspace-split.show-conversation')).toHaveCount(0);
  await expect(row(page, pickedTitle)).toBeVisible();
  await frames(page, 4);
  expect(Math.abs((await mounted(page)).scrollTop - top)).toBeLessThanOrEqual(1);
});

test('switching to another workspace starts its list at the top', async ({ page }, testInfo) => {
  desktop(testInfo);
  await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/sessions/${seededRows()[20].id}`);
  await expect(row(page, title(21))).toBeVisible();
  await scrollListTo(page, 64 * 300);
  expect((await mounted(page)).scrollTop).toBeGreaterThan(0);
  // In the app, not a reload: the column is the same element the last list scrolled.
  await page.getByText(PAGED.name, { exact: true }).first().click();
  await expect(row(page, 'Paged session 0001')).toBeVisible();
  await frames(page, 4);
  expect((await mounted(page)).scrollTop).toBe(0);
});
