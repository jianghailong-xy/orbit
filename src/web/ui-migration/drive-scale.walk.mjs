// The Drive page's scale walk (board drive-web 'Type and spacing'): the built app (`npm run build && npm run preview --
// --port 4199`) at the widths in WIDTHS (default 1280,1440,2560), with the Drive chat's column in place as the page draws
// it by default, a settled list, and the Drive API answered from memory. It writes screenshots and computed.json to the
// directory given as the first argument and exits 1 when Name is narrower than 240px at any width, when the head row
// overlaps, or when Size does not start at the writer column's end where that column shows (the 2560 case).
import { chromium } from '@playwright/test';
import { installFixtures } from './fixtures.mjs';
import { writeFileSync } from 'node:fs';
const OUT = process.argv[2];
const AT = '2026-11-20T09:00:00.000Z';
const mk = (id, parentId, kind, name, sizeBytes = 0, writer = { kind: 'OWNER', sessionId: null }) => ({ id, parentId, kind, name, sizeBytes, writer });
const E = [
  mk('root', null, 'FOLDER', 'Drive'),
  mk('books', 'root', 'FOLDER', 'Books'),
  mk('lab', 'root', 'FOLDER', 'Lab evidence'),
  mk('video', 'root', 'FOLDER', 'Video'),
  mk('c1', 'books', 'FILE', 'cover-001.jpg', 1_200_000, { kind: 'AGENT', sessionId: 'sess-1' }),
  mk('c2', 'books', 'FILE', 'cover-002.jpg', 980_000, { kind: 'AGENT', sessionId: 'sess-1' }),
  mk('cat', 'books', 'FILE', 'catalog.md', 14_000),
  mk('pdf', 'books', 'FILE', 'book-0412.pdf', 212_000_000),
];
const view = (e) => ({ id: e.id, parentId: e.parentId, kind: e.kind, name: e.name, sizeBytes: e.sizeBytes, mtime: AT,
  currentVersionId: e.kind === 'FILE' ? `v-${e.id}` : null, seq: 1, createdAt: AT, updatedAt: AT,
  lastWriter: { kind: e.writer.kind, sessionId: e.writer.sessionId, runnerId: null, at: AT } });
const pathOf = (id) => { const e = E.find((x) => x.id === id); return e.parentId === null ? '' : `${pathOf(e.parentId)}/${e.name}`; };
const results = {};
const browser = await chromium.launch();
for (const width of (process.env.WIDTHS||'1280,1440,2560').split(',').map(Number)) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await installFixtures(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()); const p = url.pathname.replace(/^\/api/, ''); const json = (b) => route.fulfill({ status: 200, json: b });
    if (p === '/drive/entries') { const pid = url.searchParams.get('parentId') ?? 'root'; return json({ folder: view(E.find((e) => e.id === pid)), entries: E.filter((e) => e.parentId === pid).map(view), nextCursor: null }); }
    let m = /^\/drive\/entries\/([^/]+)$/.exec(p); if (m) return json({ ...view(E.find((e) => e.id === m[1])), path: pathOf(m[1]) });
    if (/\/drive\/entries\/[^/]+\/versions$/.test(p)) return json({ entry: null, versions: [] });
    if (p === '/share-links') return json({ links: [] });
    if (p === '/sessions/sess-1') return json({ id: 'sess-1', title: 'Sync books to Orbit' });
    if (p === '/drive/chats') return json({ workspace: { id: 'w-cloud', name: 'Orbit Cloud', runnerId: 'r-cloud', provider: null, model: null }, workspaceFrom: 'ORBIT_CLOUD', fab: { needsYou: 0, working: false }, chats: [], more: false });
    if (p === '/drive/syncs') return json({ syncs: [] });
    if (p.startsWith('/drive/')) return json({ groups: [], entries: [], nextCursor: null });
    if (false) return json({ groups: [], entries: [], nextCursor: null });
    return route.fallback();
  });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:4199/drive?folder=books');
  await page.waitForSelector('tr.files-row');
  await page.waitForFunction(() => !/Loading your workspace/.test(document.body.innerText), null, { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.mouse.move(5, 5);
  const read = () => page.evaluate(() => {
    const cs = (el) => getComputedStyle(el), r = (el) => el.getBoundingClientRect();
    const h1 = document.querySelector('.files-head h1'); const treeRow = document.querySelector('.files-tree-row');
    const row = document.querySelector('tr.files-row'); const th = document.querySelector('.files-list th');
    const w = row.querySelector('.files-col-writer'); const a = w.querySelector('a');
    const size = row.querySelector('.files-col-size'); const head = document.querySelector('.files-head');
    const search = document.querySelector('.files-head input');
    return { title: h1.textContent, titleFont: [cs(h1).fontSize, cs(h1).fontWeight], crumbLine: !!document.querySelector('.files-crumbs'),
      headBorderBottom: cs(head).borderBottomWidth, headPadding: cs(head).padding, searchPlaceholder: search.placeholder, searchAria: search.getAttribute('aria-label'), searchHeight: r(search).height,
      treeRow: [cs(treeRow).fontSize, r(treeRow).height], tableRow: [cs(row.querySelector('.files-col-name')).fontSize, r(row).height],
      head: [cs(th).fontSize, r(th).height], writer: { color: cs(a).color, textDecoration: cs(a).textDecorationLine, fontSize: cs(w).fontSize, aria: a.getAttribute('aria-label'), text: a.textContent, cellColor: cs(w).color },
      sizeFontSize: cs(size).fontSize, sizeColor: cs(size).color, layout: cs(document.querySelector('.files-list')).tableLayout,
      writerEnd: r(w).right, sizeStart: r(size).left, writerWidth: r(w).width, nameWidth: r(row.querySelector('.files-col-name')).width, nameHeadWidth: r(document.querySelector('.files-list th.files-col-name')).width, writerHeadLeft: r(document.querySelector('.files-list th.files-col-writer')).left, nameHeadLeft: r(document.querySelector('.files-list th.files-col-name')).left, writerDisplay: cs(w).display, slot: !!document.querySelector('.wk-chat-slot,.wk-chat-panel'), sizeWidth: r(size).width, whenWidth: r(row.querySelector('.files-col-when')).width,
      moreOpacityIdle: cs(row.querySelector('.files-row-more')).opacity };
  });
  const idle = await read();
  await page.screenshot({ path: `${OUT}/drive-${width}-idle.png` });
  await page.hover('tr.files-row:first-of-type'); await page.waitForTimeout(500);
  const hover = await page.evaluate(() => { const row = document.querySelector('tr.files-row'); const a = row.querySelector('.files-col-writer a'); const s = getComputedStyle(a); return { color: s.color, textDecoration: s.textDecorationLine, moreOpacity: getComputedStyle(row.querySelector('.files-row-more')).opacity }; });
  await page.screenshot({ path: `${OUT}/drive-${width}-hover.png` });
  await page.click('tr.files-row:first-of-type td.files-col-name', { timeout: 4000, force: true }).catch(() => {});
  await page.waitForSelector('.files-pane', { timeout: 3000 }).catch(() => {});
  await page.mouse.move(5, 5);
  const pane = await page.evaluate(() => ({ present: !!document.querySelector('.files-pane'), writerColumnVisible: getComputedStyle(document.querySelector('.files-list th.files-col-writer')).display !== 'none',
    paneTitle: document.querySelector('.files-pane-name') && getComputedStyle(document.querySelector('.files-pane-name')).fontSize, paneFacts: document.querySelector('.files-pane-facts') && getComputedStyle(document.querySelector('.files-pane-facts')).fontSize,
    sizeStart: document.querySelector('tr.files-row .files-col-size').getBoundingClientRect().left, rowH: document.querySelector('tr.files-row').getBoundingClientRect().height }));
  await page.screenshot({ path: `${OUT}/drive-${width}-details.png` });
  results[width] = { idle, hover, pane, errors, gapSizeAfterWriter: idle.sizeStart - idle.writerEnd };
  await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}/computed.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
const failures = [];
for (const [width, { idle }] of Object.entries(results)) {
  if (!idle.slot) failures.push(`${width}: the chat column is not in place`);
  if (idle.nameWidth < 240) failures.push(`${width}: Name is ${idle.nameWidth}px, under 240`);
  if (idle.writerDisplay !== 'none') {
    if (idle.writerHeadLeft < idle.nameHeadLeft + idle.nameHeadWidth - 1) failures.push(`${width}: the Name and Last written by heads overlap`);
    if (Math.abs(idle.sizeStart - idle.writerEnd) > 40) failures.push(`${width}: Size starts ${idle.sizeStart - idle.writerEnd}px from the writer column's end`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
