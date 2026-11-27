// Real-build shots (and a recording) of dragging a session row onto a folder (lib/sessionDrag).
//
// Not a test: run by hand against `npm run preview` of a fresh `npm run build`, with the UI-migration
// fixtures answering every API call and the list, the folders and the move answered here:
//   node src/web/ui-migration/session-folder-drag.capture.mjs <outDir> [baseURL]
// Writes PNGs, a .webm of the whole run and a log of the move requests into <outDir>.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { uuidToBase62 } from '@orbit/shared';
import { installFixtures, installFixedDate } from './fixtures.mjs';
import { SESSION, WORKSPACE } from './session-fixtures.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: session-folder-drag.capture.mjs <outDir> [baseURL]');
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
let rows = [
  { ...SESSION, lastTurnAt: hour(0), folderId: null },
  row(101, 'Draft the changelog', { folderId: folders[0].id }),
  row(102, 'Tag the build', { folderId: folders[0].id }),
  row(103, 'Coordinates the launch project', {
    projectMembership: { projectId: id(950), projectTitle: 'Launch', projectStatus: 'OPEN', role: 'COORDINATOR' },
  }),
  ...Array.from({ length: 26 }, (_, i) => row(110 + i, [
    'Fix the login redirect', 'Profile the list query', 'Write the folder docs', 'Trim the bundle',
    'Check the dark theme', 'Rename the settings keys', 'Review the runner logs', 'Audit the toasts',
  ][i % 8] + ` #${i + 1}`)),
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

await page.goto(`/sessions/${SESSION.id}`);
await page.locator('#boot').waitFor({ state: 'detached' }).catch(() => page.locator('#boot').waitFor({ state: 'hidden' }));
await folderRow('Wiki').waitFor();
await sessionRow('Review the component migration').waitFor();
await settle(800);
note(`draggable rows: ${await page.locator('.session-row[draggable="true"]').count()} of ${await page.locator('.session-row').count()}`);
note(`project rows draggable: ${await page.locator('.session-project-row[draggable]').count()}`);
await shot('1-list-before');

// 1–2. Hovering a folder lights it; dropping files the row there, with Move…'s toast.
await dragTo(sessionRow('Review the component migration'), folderRow('Wiki'), { drop: false });
note(`hover: Wiki lit=${await folderRow('Wiki').evaluate((el) => el.classList.contains('drop-target'))}, Release lit=${await folderRow('Release').evaluate((el) => el.classList.contains('drop-target'))}`);
await shot('2-hover-highlights-folder');
await page.mouse.up();
await page.getByText('Moved to “Wiki”').waitFor();
note(`after drop on Wiki: moves=${JSON.stringify(moves)}`);
await shot('3-dropped-moved-to-toast');

// 6. A coordinator row is not picked up: dragging it over a folder lights nothing, moves nothing.
const before = moves.length;
await dragTo(page.locator('.session-project-row').first(), folderRow('Release'), { drop: false });
note(`coordinator drag: Release lit=${await folderRow('Release').evaluate((el) => el.classList.contains('drop-target'))}`);
await shot('4-coordinator-row-not-dragged');
await page.mouse.up();
await settle();
note(`coordinator drop: new moves=${moves.length - before}`);

// 4. From a row far down, a drag held at the list's top edge scrolls it up to the folders.
await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
await settle();
const far = sessionRow('Audit the toasts #24');
await far.waitFor();
const startTop = await list.evaluate((el) => el.scrollTop);
const box = await list.boundingBox();
const a = await far.boundingBox();
await page.mouse.move(a.x + 60, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(a.x + 70, a.y + a.height / 2 - 6, { steps: 4 });
await page.mouse.move(box.x + 120, box.y + box.height - 20, { steps: 6 });
await shot('5a-autoscroll-start-far-down');
await page.mouse.move(box.x + 120, box.y + 6, { steps: 10 });
for (let i = 0; i < 40 && (await list.evaluate((el) => el.scrollTop)) > 0; i += 1) {
  await page.mouse.move(box.x + 120 + (i % 2), box.y + 6);
  await page.waitForTimeout(60);
}
const endTop = await list.evaluate((el) => el.scrollTop);
note(`autoscroll: scrollTop ${startTop} -> ${endTop}`);
await shot('5b-autoscroll-reached-top');
await page.mouse.move(box.x + 120, box.y + 200, { steps: 4 });
const release = await folderRow('Release').boundingBox();
await page.mouse.move(release.x + 80, release.y + release.height / 2, { steps: 8 });
await settle(250);
await shot('5c-autoscroll-then-over-release');
await page.mouse.up();
await page.getByText('Moved to “Release”').waitFor();
note(`after autoscroll drop on Release: last move=${JSON.stringify(moves.at(-1))}`);
await shot('5d-autoscroll-dropped');

// 3. Inside a folder, the head (back control and title) is No Folder.
await folderRow('Release').click();
await page.locator('.session-folder-title', { hasText: 'Release' }).waitFor();
await settle(600);
await shot('6-inside-release');
await dragTo(sessionRow('Draft the changelog'), page.locator('.session-folder-back'), { drop: false });
note(`inside folder hover head: lit=${await page.locator('.session-folder-head').evaluate((el) => el.classList.contains('drop-target'))}`);
await shot('7-hover-folder-head-no-folder');
await page.mouse.up();
await page.getByText('Moved out of “Release”').waitFor();
note(`after drop on head: last move=${JSON.stringify(moves.at(-1))}`);
await shot('8-dropped-out-of-folder');

// 7. Files dropped on the session pane still upload: the pane takes a Files drag and says so.
const pane = page.locator('.workspace-view');
const files = await page.evaluateHandle(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  return dt;
});
await pane.dispatchEvent('dragenter', { dataTransfer: files });
await pane.dispatchEvent('dragover', { dataTransfer: files });
await page.locator('.workspace-dropzone').waitFor();
note(`files over the pane: dropzone="${await page.locator('.workspace-dropzone').innerText()}"`);
await shot('9-file-drop-still-offered');
await pane.dispatchEvent('drop', { dataTransfer: files });
await settle();
note(`after file drop: attachment chips=${await page.locator('.composer-attachment, .attachment-chip, .composer-chip').count()}; moves total=${moves.length}`);
await shot('10-file-dropped-attached');

await page.close();
await context.close();
await browser.close();
for (const file of readdirSync(out)) if (file.endsWith('.webm')) renameSync(`${out}/${file}`, `${out}/session-folder-drag-web.webm`);
writeFileSync(`${out}/log.txt`, `${log.join('\n')}\n`);
console.log(`wrote ${out}`);
