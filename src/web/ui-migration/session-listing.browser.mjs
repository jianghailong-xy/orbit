import { test, expect } from '@playwright/test';
import { uuidToBase62 } from '@orbit/shared';
import { installFixtures, installFixedDate, FIXED_NOW } from './fixtures.mjs';
import { RUNNER, WORKSPACE } from './session-fixtures.mjs';
import { answerListing, answerPlacement } from './session-listing-fixtures.mjs';

// The session column read from GET /sessions/listing a page at a time (docs/session-list-scale-design.md §3), on
// the production build with the UI-migration fixtures answering every call and a seeded workspace answered here:
// 1,500 Open sessions with four folders and three projects (one held here, one filed in a folder, one whose
// coordinator runs in another workspace), a pinned session and a tag. The listing is answered by the server's own
// rules (session-listing-fixtures.mjs, over src/apiserver/src/sessions/session-listing.ts) and GET /sessions from
// the same rows, so the build before the change (which read the whole Open list and grouped it itself) and this
// one can draw the same seed.
//
// What it shows: a page load reads one page of the listing and no whole Open list; the column (folder counts,
// project rows, section order) is the previous build's, by its reference shot; a folder's page reads the
// listing with `folderId`; Trash and a tag's list keep paging GET /sessions; scrolling reads the next page.
//
// SESSION_LISTING_DIST set: the previous build is served, and only the reference shot is taken (--update-snapshots).

const PREVIOUS = !!process.env.SESSION_LISTING_DIST;
const SEEDED = 1500;
const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const OTHER = { ...WORKSPACE, id: id(21), name: 'Other workspace' };
const FOLDERS = [
  { id: id(901), workspaceId: WORKSPACE.id, name: 'Release' },
  { id: id(902), workspaceId: WORKSPACE.id, name: 'Wiki' },
  { id: id(903), workspaceId: WORKSPACE.id, name: 'Sprint 10' },
  { id: id(904), workspaceId: WORKSPACE.id, name: 'Sprint 2' },
];
const TAG = { id: id(970), name: 'Design', color: '#7c5cff' };
const PROJECTS = [
  { id: id(950), title: 'Launch checklist' },
  { id: id(951), title: 'Docs refresh' },
  { id: id(952), title: 'Billing migration' },
];
const minutesAgo = (m) => new Date(Date.parse(FIXED_NOW) - m * 60_000).toISOString();
const pad = (n) => String(n).padStart(4, '0');
const title = (n) => `Seeded session ${pad(n)}`;
const membership = (project, role = 'TASK') =>
  ({ projectMembership: { projectId: project.id, projectTitle: project.title, projectStatus: 'OPEN', role } });
const seed = (n, workspace, rowTitle, extra = {}) => ({
  id: id(100_000 + n),
  workspaceId: workspace.id, workspace, runnerId: RUNNER.id, assignedRunnerId: RUNNER.id,
  title: rowTitle, provider: 'claude', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
  createdAt: minutesAgo(n * 7), updatedAt: minutesAgo(n * 7), startedAt: minutesAgo(n * 7), engineStartedAt: minutesAgo(n * 7),
  lastTurnAt: minutesAgo(n * 7), listedAt: minutesAgo(n * 7), lastAssistantText: `Reply ${pad(n)}`, folderId: null, shareToken: null,
  tags: [], pinnedAt: null,
  ...extra,
});
const needsYou = { pendingApprovals: 1, waitingKind: 'OWNER_ITEM' };
/** Seeds 1–10 in Release (3 and 7 wait on you), 11–20 in Wiki; project 950 coordinated by 25 holding 26–40 (30 waits
 *  on you); 951 coordinated by 50 in Sprint 10, holding 51–55; 952's coordinator in the other workspace, its members
 *  60–62 rows here; 100 pinned; 200–260 tagged Design; and five in Trash. */
function seededRows() {
  const rows = Array.from({ length: SEEDED }, (_, i) => {
    const n = i + 1;
    const extra = {};
    if (n <= 10) extra.folderId = FOLDERS[0].id;
    else if (n <= 20) extra.folderId = FOLDERS[1].id;
    if (n === 3 || n === 7 || n === 30) Object.assign(extra, needsYou);
    if (n === 25) Object.assign(extra, membership(PROJECTS[0], 'COORDINATOR'));
    if (n > 25 && n <= 40) Object.assign(extra, membership(PROJECTS[0]));
    if (n === 50) Object.assign(extra, membership(PROJECTS[1], 'COORDINATOR'), { folderId: FOLDERS[2].id });
    if (n > 50 && n <= 55) Object.assign(extra, membership(PROJECTS[1]));
    if (n >= 60 && n <= 62) Object.assign(extra, membership(PROJECTS[2]));
    if (n === 100) extra.pinnedAt = minutesAgo(5);
    if (n >= 200 && n <= 260) extra.tags = [TAG];
    return seed(n, WORKSPACE, title(n), extra);
  });
  const elsewhere = seed(5_000, OTHER, 'Billing coordinator', membership(PROJECTS[2], 'COORDINATOR'));
  const trash = Array.from({ length: 5 }, (_, i) => seed(6_000 + i, WORKSPACE, `Trashed session ${i + 1}`, { lifecycleState: 'TRASH' }));
  return [...rows, elsewhere, ...trash];
}
const sidebarProject = (project) => ({
  id: project.id, title: project.title, status: 'OPEN', createdAt: FIXED_NOW, updatedAt: FIXED_NOW, lastActivityAt: FIXED_NOW,
  buckets: { running: 0, ready: 1, blocked: 0, awaitingVerification: 0, done: 2, failed: 0, cancelled: 0 },
  taskCounts: { done: 2, failed: 0, total: 5 },
  attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null, ownerItems: [], coordinatorItems: null, startRequest: null },
  startedAt: FIXED_NOW, pausedAt: null, coordinatorEnabled: true, maxConcurrentTasks: 2, configRevision: '1',
});

/** Answers the seeded workspace's reads, recording every list read; everything else falls to the UI-migration fixtures. */
async function seedList(page, { theme }) {
  await installFixedDate(page);
  await installFixtures(page, { theme });
  const state = { rows: seededRows(), listReads: [], listingReads: [], moves: [] };
  const byId = () => new Map(state.rows.map((row) => [row.id, row]));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const q = url.searchParams;
    const method = request.method();
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (method === 'GET' && path === '/api/workspaces') return json([WORKSPACE, OTHER]);
    if (method === 'GET' && path === '/api/session-folders') return json(FOLDERS);
    if (method === 'GET' && path === '/api/session-tags') return json([TAG]);
    if (method === 'GET' && path === '/api/projects/sidebar') return json(PROJECTS.map(sidebarProject));
    if (method === 'GET' && path === '/api/watches') return json([]);
    if (method === 'GET' && path === '/api/sessions/project-placement') return json(answerPlacement(state.rows, q));
    if (method === 'GET' && path === '/api/sessions/listing') {
      const answer = answerListing(state.rows, FOLDERS, q);
      state.listingReads.push({ query: Object.fromEntries(q), entries: answer.entries.length, next: answer.next, folders: answer.folders ?? null });
      return json(answer);
    }
    if (method === 'GET' && path === '/api/sessions') {
      state.listReads.push(Object.fromEntries(q));
      if (q.get('scheduled') || q.get('projectId')) return json([]);
      const view = q.get('view') ?? 'open';
      const lifecycle = view === 'trash' ? 'TRASH' : view === 'completed' ? 'COMPLETED' : 'OPEN';
      const rows = state.rows.filter((row) =>
        (!q.get('workspaceId') || row.workspaceId === q.get('workspaceId')) && row.lifecycleState === lifecycle &&
        (!q.get('tagId') || row.tags.some((tag) => tag.id === q.get('tagId'))));
      const limit = Number(q.get('limit') || 0);
      return json(limit ? rows.slice(0, limit) : rows);
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
const projectRow = (page, name) => page.locator('.session-list-window .session-project-row', { hasText: name });
const menu = (page) => page.locator('[role="menu"]').filter({ visible: true });
const menuItem = (page, name) => menu(page).getByRole('menuitem', { name, exact: false }).filter({ visible: true }).first();
/** A read of the whole Open list: GET /sessions in the Open view (the server's default) with no page size. A
 *  Scheduled runs folder's read (`scheduled=1`, that folder's runs alone) and a project page's are other lists. */
const wholeOpenReads = (state) => state.listReads.filter((q) =>
  (!q.view || q.view === 'open') && !q.limit && !q.scheduled && !q.projectId && !q.since);
const topListing = (state) => state.listingReads.filter((r) => r.query.workspaceId === WORKSPACE.id && !r.query.folderId);
/** What the column draws from its top, item by item: the folder rows, section heads and rows mounted. */
const columnShape = (page) => list(page).evaluate((el) => [...el.querySelectorAll('.session-list-window > .session-list-item')]
  .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
  .map((item) => item.innerText.replace(/\s+/g, ' ').trim())
  .filter(Boolean));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('a page load reads one page of the listing and never the whole Open list', async ({ page }, testInfo) => {
  test.skip(PREVIOUS, 'this build only');
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/workspaces/${WORKSPACE.id}`);
  await expect(folderRow(page, 'Release')).toBeVisible();
  await expect(projectRow(page, 'Launch checklist')).toBeVisible();
  await page.waitForTimeout(1500);
  await testInfo.attach('list reads', { body: JSON.stringify({ listReads: state.listReads, listingReads: state.listingReads }, null, 2), contentType: 'application/json' });
  expect(wholeOpenReads(state)).toEqual([]);
  // The splash warmed the key the console reads: one read of the first page, whatever else the load did.
  const first = topListing(state);
  expect(first.filter((r) => !r.query.after)).toHaveLength(1);
  expect(first[0].query).toMatchObject({ view: 'open', limit: '40' });
  expect(first[0].entries).toBeLessThanOrEqual(40);
  expect(first[0].next).not.toBeNull();
  // Its folder rows are the server's tallies, by name: Release's 10 rows (two wait on you), Sprint 2 empty, Sprint 10
  // holding a project's one row, Wiki's 10.
  expect(first[0].folders.map((f) => [f.rowCount, f.needsYou])).toEqual([[10, 2], [0, 0], [1, 0], [10, 0]]);
  // A folder with sessions waiting on you shows how many in place of its count.
  await expect(folderRow(page, 'Release').locator('.session-folder-needs')).toHaveText('2');
  await expect(folderRow(page, 'Wiki').locator('.session-folder-count')).toHaveText('10');
  await expect(folderRow(page, 'Sprint 10').locator('.session-folder-count')).toHaveText('1');
});

test('the column draws the seed as the previous build did: folder counts, project rows and section order', async ({ page }, testInfo) => {
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/workspaces/${WORKSPACE.id}/new`);
  await expect(folderRow(page, 'Release')).toBeVisible();
  await expect(projectRow(page, 'Launch checklist')).toBeVisible();
  await expect(row(page, title(21))).toBeVisible();
  await page.waitForTimeout(1500);
  await frames(page, 4);
  const shape = await columnShape(page);
  await testInfo.attach('column', { body: JSON.stringify(shape, null, 2), contentType: 'application/json' });
  await testInfo.attach('list reads', { body: JSON.stringify({ listReads: state.listReads, listingReads: state.listingReads }, null, 2), contentType: 'application/json' });
  // Item by item, as text, then as pixels.
  expect(JSON.stringify(shape, null, 2)).toMatchSnapshot('column.json');
  await expect(page.locator('.session-col').first()).toHaveScreenshot('column.png', { maxDiffPixels: 0 });
  // Further down: the members of a project coordinated in the other workspace, each its own row with the mark.
  await list(page).evaluate((el) => { el.scrollTop = 1100; });
  await expect(row(page, title(61))).toBeVisible();
  await page.waitForTimeout(500);
  await frames(page, 4);
  expect(JSON.stringify(await columnShape(page), null, 2)).toMatchSnapshot('column-members.json');
  await expect(page.locator('.session-col').first()).toHaveScreenshot('column-members.png', { maxDiffPixels: 0 });
  // A folder's page: Sprint 10 lists the project filed with its coordinator.
  await page.goto(`/workspaces/${WORKSPACE.id}/new?folder=${FOLDERS[2].id}`);
  await expect(projectRow(page, 'Docs refresh')).toBeVisible();
  await page.waitForTimeout(1000);
  await frames(page, 4);
  expect(JSON.stringify(await columnShape(page), null, 2)).toMatchSnapshot('folder-page.json');
  await expect(page.locator('.session-col').first()).toHaveScreenshot('folder-page.png', { maxDiffPixels: 0 });
});

test('a folder\'s page reads the listing with its folderId', async ({ page }, testInfo) => {
  test.skip(PREVIOUS, 'this build only');
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/workspaces/${WORKSPACE.id}/new`);
  await folderRow(page, 'Release').click();
  await expect(row(page, title(1))).toBeVisible();
  await expect(row(page, title(21))).toHaveCount(0);
  const reads = state.listingReads.filter((r) => r.query.folderId === FOLDERS[0].id);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads[0].query).toMatchObject({ workspaceId: WORKSPACE.id, view: 'open', limit: '40' });
  expect(reads[0].folders).toBeNull();
  // A project is filed with its coordinator: Sprint 10's page is the project's row.
  await page.goto(`/workspaces/${WORKSPACE.id}/new?folder=${FOLDERS[2].id}`);
  await expect(projectRow(page, 'Docs refresh')).toBeVisible();
  expect(state.listingReads.some((r) => r.query.folderId === FOLDERS[2].id)).toBe(true);
  expect(wholeOpenReads(state)).toEqual([]);
});

test('Trash and a tag\'s list keep paging GET /sessions', async ({ page }, testInfo) => {
  test.skip(PREVIOUS, 'this build only');
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/workspaces/${WORKSPACE.id}/new`);
  await expect(folderRow(page, 'Release')).toBeVisible();
  const listingBefore = state.listingReads.length;
  await page.locator('.session-scope-menu').click();
  await menuItem(page, 'Filter by Tag').click();
  await menuItem(page, 'Design').click();
  await page.keyboard.press('Escape');
  await expect(row(page, title(200))).toBeVisible();
  await expect(folderRow(page, 'Release')).toHaveCount(0);
  expect(state.listReads.some((q) => q.tagId === TAG.id && q.limit === '40' && q.workspaceId === WORKSPACE.id)).toBe(true);
  await page.locator('.session-scope-menu').click();
  await menuItem(page, 'Filter by Tag').click();
  await menuItem(page, 'All').click();
  await page.keyboard.press('Escape');
  await page.locator('.session-scope-menu').click();
  await menuItem(page, 'Trash').click();
  await expect(row(page, 'Trashed session 1')).toBeVisible();
  expect(state.listReads.some((q) => q.view === 'trash' && q.limit === '40' && q.workspaceId === WORKSPACE.id)).toBe(true);
  // Neither read the listing.
  expect(state.listingReads.slice(listingBefore).filter((r) => r.query.view !== 'open' || r.query.tagId)).toEqual([]);
  expect(wholeOpenReads(state)).toEqual([]);
});

test('scrolling to the end of the listing reads its next page', async ({ page }, testInfo) => {
  test.skip(PREVIOUS, 'this build only');
  const state = await seedList(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(`/workspaces/${WORKSPACE.id}/new`);
  await expect(folderRow(page, 'Release')).toBeVisible();
  await expect.poll(() => topListing(state).length).toBe(1);
  const first = topListing(state)[0];
  await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => topListing(state).length).toBe(2);
  expect(topListing(state)[1].query.after).toBe(first.next);
  expect(topListing(state)[1].folders).toBeNull();
  // The last entry of the first page and the first of the second are both drawn, in order, once.
  await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await frames(page, 4);
  const titles = await list(page).evaluate((el) => [...el.querySelectorAll('.session-list-window .session-title')].map((t) => t.textContent));
  expect(new Set(titles).size).toBe(titles.length);
  expect(wholeOpenReads(state)).toEqual([]);
});
