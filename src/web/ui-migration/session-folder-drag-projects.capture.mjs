// Real-build shots (and a recording) of dragging PROJECT rows and pinned rows onto a folder (lib/sessionDrag).
//
// Not a test: run by hand against `npm run preview` of a fresh `npm run build`, with the UI-migration
// fixtures answering every API call and the list, the folders and the move answered here:
//   node src/web/ui-migration/session-folder-drag-projects.capture.mjs <outDir> [baseURL]
// Writes PNGs, a .webm of the whole run and a log of the move requests into <outDir>.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { uuidToBase62 } from '@orbit/shared';
import { installFixtures, installFixedDate } from './fixtures.mjs';
import { SESSION, WORKSPACE } from './session-fixtures.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: session-folder-drag-projects.capture.mjs <outDir> [baseURL]');
const baseURL = process.argv[3] ?? 'http://127.0.0.1:4173';
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
const coord = (n, title, project, extra = {}) => row(n, title, {
  projectMembership: { projectId: id(project), projectTitle: `Project ${project}`, projectStatus: 'OPEN', role: 'COORDINATOR' }, ...extra,
});
const member = (n, title, project, extra = {}) => row(n, title, {
  projectMembership: { projectId: id(project), projectTitle: `Project ${project}`, projectStatus: 'OPEN', role: 'TASK' }, ...extra,
});
const PIN = '2026-09-28T10:00:00.000Z';
let rows = [
  { ...SESSION, lastTurnAt: hour(0), folderId: null },
  row(104, 'Pinned plain session', { pinnedAt: PIN }),
  coord(103, 'Pinned launch coordinator', 950, { pinnedAt: PIN }),
  member(105, 'Launch task one', 950),
  coord(106, 'Docs coordinator', 951, { folderId: folders[0].id }),
  member(107, 'Docs task one', 951, { folderId: folders[0].id }),
  row(101, 'Draft the changelog', { folderId: folders[0].id }),
  member(108, 'Orphan task of a project with no coordinator', 952),
];
const moves = [];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 760 }, baseURL, locale: 'en-US', timezoneId: 'UTC',
  recordVideo: { dir: out, size: { width: 1280, height: 760 } },
});
const page = await context.newPage();
await installFixedDate(page);
await installFixtures(page, { theme: 'light' });
// Registered after installFixtures, so these answer first.
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

const settle = async (ms = 400) => {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const shot = async (name) => { await settle(); await page.screenshot({ path: `${out}/${name}.png` }); };
const list = page.locator('.session-col-list');
const sessionRow = (title) => page.locator('.session-row', { has: page.locator('.session-title', { hasText: title }) }).first();
const folderRow = (name) => page.locator('.session-folder-row', { has: page.locator('.session-folder-name', { hasText: name }) });
/** A real HTML5 drag with the mouse: press on `from`, move in steps onto `to`, hold. */
const dragTo = async (from, to, { drop = true } = {}) => {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + 60, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 70, a.y + a.height / 2 + 6, { steps: 4 });
  await page.mouse.move(b.x + 80, b.y + b.height / 2, { steps: 12 });
  await settle(250);
  if (drop) await page.mouse.up();
};
const log = [];
const note = (line) => { log.push(line); console.log(line); };
const projectRow = (title) => page.locator('.session-project-row', { hasText: title }).first();
const count = async (name) => (await folderRow(name).locator('.session-folder-count').innerText()).trim();
const lit = (loc) => loc.evaluate((el) => el.classList.contains('drop-target'));

await page.goto(`/sessions/${SESSION.id}`);
await page.locator('#boot').waitFor({ state: 'detached' }).catch(() => page.locator('#boot').waitFor({ state: 'hidden' }));
await folderRow('Wiki').waitFor();
await projectRow('Project 950').waitFor();
await settle(800);
note(`project rows draggable: ${await page.locator('.session-project-row[draggable="true"]').count()} of ${await page.locator('.session-project-row').count()}`);
note(`orphan (no coordinator) row draggable attr: ${await projectRow('Project 952').getAttribute('draggable')}`);
note(`pinned plain draggable attr: ${await sessionRow('Pinned plain session').getAttribute('draggable')}`);
note(`counts before: Wiki=${await count('Wiki')} Release=${await count('Release')}`);
await shot('1-list-before');

// A project with no coordinator is not picked up.
let before = moves.length;
await dragTo(projectRow('Project 952'), folderRow('Wiki'), { drop: false });
note(`no-coordinator drag: Wiki lit=${await lit(folderRow('Wiki'))}`);
await shot('2-no-coordinator-not-dragged');
await page.mouse.up();
await settle();
note(`no-coordinator drop: new moves=${moves.length - before}`);

// A pinned project row onto Wiki.
await dragTo(projectRow('Project 950'), folderRow('Wiki'), { drop: false });
note(`pinned project hover: Wiki lit=${await lit(folderRow('Wiki'))}`);
await shot('3-pinned-project-hover-wiki');
await page.mouse.up();
await page.getByText('Moved to “Wiki”').waitFor();
await settle(800);
note(`after pinned project drop: last move=${JSON.stringify(moves.at(-1))} counts Wiki=${await count('Wiki')}`);
await shot('4-pinned-project-dropped-toast');

// A pinned plain session onto Release.
await page.waitForTimeout(3500);
await dragTo(sessionRow('Pinned plain session'), folderRow('Release'), { drop: false });
note(`pinned plain hover: Release lit=${await lit(folderRow('Release'))}`);
await shot('5-pinned-plain-hover-release');
await page.mouse.up();
await page.getByText('Moved to “Release”').waitFor();
await settle(800);
note(`after pinned plain drop: last move=${JSON.stringify(moves.at(-1))} counts Release=${await count('Release')}`);
await shot('6-pinned-plain-dropped-toast');

// Inside Release, a project row dropped on the folder head goes to No Folder.
await folderRow('Release').click();
await page.locator('.session-folder-title', { hasText: 'Release' }).waitFor();
await settle(800);
await shot('7-inside-release');
await dragTo(projectRow('Project 951'), page.locator('.session-folder-back'), { drop: false });
note(`inside folder hover head: lit=${await page.locator('.session-folder-head').evaluate((el) => el.classList.contains('drop-target'))}`);
await shot('8-project-hover-folder-head');
await page.mouse.up();
await page.getByText('Moved out of “Release”').waitFor();
await settle(800);
note(`after drop on head: last move=${JSON.stringify(moves.at(-1))}`);
await shot('9-project-out-of-folder');

await page.close();
await context.close();
await browser.close();
for (const file of readdirSync(out)) if (file.endsWith('.webm')) renameSync(`${out}/${file}`, `${out}/session-folder-drag-projects-web.webm`);
writeFileSync(`${out}/log.txt`, `${log.join('\n')}\n`);
console.log(`wrote ${out}`);
