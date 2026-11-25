// The cross-client check's real-stack walk: the built console on the tip's apiserver and PostgreSQL, over the cases
// server-payloads.cjs seeded, read from the DOM and screenshotted on every web surface that draws a session's state:
// the session list row and its group, the session header (phone width), the task panel's run badge, the Tasks list,
// link cards in a conversation, the public shared page, Shared with me, the guest page and the search palette.
// Each reading is held to the board's rule (docs/mocks/session-display-three-states/capture/rules.mjs, Disconnected
// drawn as Failed). Also writes <out>/search-rows.json: the search route's own answers, for the client drivers.
// usage: node walk-cross.mjs <tip> <walk dir> <web origin> <api origin> <out dir> <playwright module path>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [tip, walk, origin, apiOrigin, out, pwModule] = process.argv.slice(2);
if (!tip || !walk || !origin || !apiOrigin || !out || !pwModule) {
  throw new Error('usage: walk-cross.mjs <tip> <walk dir> <web origin> <api origin> <out dir> <playwright module>');
}
fs.mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(pwModule);
const world = JSON.parse(fs.readFileSync(path.join(walk, 'world.json'), 'utf8'));
const password = fs.readFileSync(path.join(walk, 'pw'), 'utf8').trim();
const rules = await import(pathToFileURL(path.join(tip, 'docs/mocks/session-display-three-states/capture/rules.mjs')));
const expectOf = (p) => ({
  state: rules.sessionState(p).word,
  marks: rules.sessionMarks(p).map((m) => rules.MARKS[m === 'DISCONNECTED' ? 'FAILED' : m].word),
});

async function signIn(email) {
  const res = await fetch(`${apiOrigin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  const token = body.accessToken ?? body.access_token ?? body.token;
  if (!token) throw new Error(`login ${email}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return async (route, init = {}) => {
    const r = await fetch(`${apiOrigin}/api${route}`, {
      ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${route}: ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}
const api = await signIn(world.ownerEmail);
const guestApi = await signIn(world.guestEmail);
const asList = (b) => (Array.isArray(b) ? b : (b.sessions ?? b.items ?? b.tasks ?? []));

// ---- the API's own answers ----
const listed = [...asList(await api('/sessions')), ...asList(await api('/sessions?view=completed'))];
const tasksListed = asList(await api('/tasks'));
const guestListed = asList(await guestApi('/guest-sessions'));
const cases = {};
for (const [label, c] of Object.entries(world.cases)) {
  const row = listed.find((s) => s.title === c.title);
  if (!row) { cases[label] = { ...c, missing: 'list row' }; continue; }
  const detail = await api(`/sessions/${row.id}`);
  const guest = guestListed.find((s) => s.title === c.title) ?? null;
  let taskPublicId = tasksListed.find((t) => t.title === c.taskTitle)?.id;
  const task = await api(`/tasks/${taskPublicId ?? c.taskId}`);
  taskPublicId ??= task.id;
  cases[label] = { ...c, publicId: row.id, taskPublicId, row, detail, guest, taskRun: task.sessions?.find((s) => s.id === row.id) ?? null, expect: expectOf(row) };
}
const search = await api('/sessions/search?q=payloads&limit=50');
const searchRows = [];
for (const [label, c] of Object.entries(cases)) {
  const hit = search.hits.find((h) => h.title === c.title);
  if (hit) searchRows.push({ id: `${label}|searchHit`, name: label, kind: 'searchHit', payload: hit });
}
fs.writeFileSync(path.join(out, 'search-rows.json'), JSON.stringify(searchRows, null, 1));

// A conversation whose reply links every case, so the console draws their link cards.
const { prismaClientFor } = require(path.join(tip, 'src/apiserver/build/prisma/prisma-client.js'));
const db = prismaClientFor(process.env.DATABASE_URL);
const first = await db.session.findUniqueOrThrow({ where: { id: Object.values(world.cases)[0].sessionId } });
const linksId = crypto.randomUUID();
await db.session.create({
  data: {
    id: linksId, ownerId: first.ownerId, creatorId: first.ownerId, workspaceId: first.workspaceId, assignedRunnerId: first.assignedRunnerId,
    title: 'walk link cards', prompt: 'show me the cards', provider: 'claude', status: 'AWAITING_INPUT', lastTurnOutcome: 'ANSWERED',
    dispatchOrigin: 'USER', startedAt: new Date(), numTurns: 1,
  },
});
const text = Object.values(cases).filter((c) => c.publicId).map((c) => `[${c.title}](orbit-session:${c.publicId})`).join('\n\n');
await db.runEvent.create({ data: { sessionId: linksId, seq: 1, type: 'assistant', payload: { text } } });
await db.$disconnect();
const linksPublicId = [...asList(await api('/sessions'))].find((s) => s.title === 'walk link cards').id;

// ---- the console ----
const browser = await chromium.launch();
async function page(email, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'light' });
  const p = await context.newPage();
  if (email) {
    await p.goto(`${origin}/login`);
    await p.fill('input[name="email"]', email);
    await p.fill('input[name="password"]', password);
    await p.click('button.login-submit');
    await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  }
  return p;
}
const settle = (p, ms = 1_500) => p.waitForTimeout(ms);
const shot = (p, name, opts = {}) => p.screenshot({ path: path.join(out, `${name}.png`), ...opts });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Every state glyph (data-state) and mark chip (data-mark) under a node, as drawn.
const READ = `(node) => ({
  state: node.querySelector('[data-state]')?.getAttribute('data-state') ?? null,
  marks: [...node.querySelectorAll('[data-mark]')].map((m) => m.textContent.trim()),
  text: node.textContent.replace(/\\s+/g, ' ').trim(),
})`;

const desk = await page(world.ownerEmail, { width: 1440, height: 2600 });
await desk.waitForSelector('.session-row', { timeout: 30_000 });
await settle(desk, 2_500);
const rows = await desk.evaluate(`[...document.querySelectorAll('.session-row')].map((r) => ({
  title: r.querySelector('.session-title')?.textContent?.trim(),
  state: r.querySelector('.session-icon [data-state]')?.getAttribute('data-state') ?? null,
  stateTitle: r.querySelector('.session-icon [data-state]')?.getAttribute('title') ?? null,
  marks: [...r.querySelectorAll('.session-marks [data-mark]')].map((m) => m.textContent.trim()),
  line: r.querySelector('.session-preview')?.textContent?.trim() ?? null,
  group: r.closest('section')?.querySelector(':scope > .session-section-head')?.textContent?.trim() ?? null,
}))`);
await shot(desk, 'list', { fullPage: true });
for (const [label, c] of Object.entries(cases)) {
  c.listRow = rows.find((r) => r.title === c.title) ?? null;
  if (c.listRow) {
    await desk.locator('.session-row', { has: desk.locator('.session-title', { hasText: new RegExp(`^${c.title.replace(/[()]/g, '\\$&')}$`) }) })
      .first().screenshot({ path: path.join(out, `row-${slug(label)}.png`) });
  }
}

const phone = await page(world.ownerEmail, { width: 393, height: 852 });
for (const [label, c] of Object.entries(cases)) {
  if (!c.publicId) continue;
  await phone.goto(`${origin}/sessions/${c.publicId}`);
  await phone.waitForSelector('.workspace-sub', { timeout: 30_000 }).catch(() => {});
  await settle(phone);
  c.header = await phone.evaluate(`(${READ})(document.querySelector('.workspace-sub:not([data-fork-source])') ?? document.body.appendChild(document.createElement('i')))`);
  await shot(phone, `header-${slug(label)}`, { clip: { x: 0, y: 0, width: 393, height: 150 } });
}

for (const [label, c] of Object.entries(cases)) {
  if (!c.taskPublicId) continue;
  await desk.goto(`${origin}/tasks/${c.taskPublicId}`);
  await desk.waitForSelector('a.tdp-session', { timeout: 30_000 }).catch(() => {});
  await settle(desk);
  c.taskPanel = await desk.evaluate(() => ({
    runs: [...document.querySelectorAll('a.tdp-session')].map((a) => ({
      badge: a.querySelector('.tdp-badge')?.textContent?.trim() ?? null,
      marks: [...a.querySelectorAll('[data-mark]')].map((m) => m.textContent.trim()),
      dot: a.querySelector('.tdp-dot')?.className ?? null,
    })),
    now: document.querySelector('.tdp-now-title')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    nowMarks: [...document.querySelectorAll('.tdp-now-title [data-mark]')].map((m) => m.textContent.trim()),
  }));
  const run = desk.locator('a.tdp-session').first();
  if (await run.count()) await run.screenshot({ path: path.join(out, `run-${slug(label)}.png`) });
}

await desk.goto(`${origin}/tasks`);
await desk.waitForSelector('.task-status-cell', { timeout: 30_000 }).catch(() => {});
await settle(desk, 2_500);
const pills = await desk.evaluate(() => [...document.querySelectorAll('.task-status-cell')].map((cell) => ({
  title: cell.parentElement?.querySelector('.task-title')?.textContent?.trim() ?? null,
  word: cell.querySelector('.status-pill')?.textContent?.trim() ?? null,
  marks: [...cell.querySelectorAll('[data-mark]')].map((m) => m.textContent.trim()),
})));
await shot(desk, 'tasks-list', { fullPage: true });

await desk.goto(`${origin}/sessions/${linksPublicId}`);
await desk.waitForSelector('.olc-state', { timeout: 30_000 }).catch(() => {});
await settle(desk, 3_000);
await shot(desk, 'linkcards-page', { fullPage: true });
const cards = await desk.evaluate(() => [...document.querySelectorAll('.orbit-link-card')].map((card) => ({
  title: card.querySelector('.olc-title')?.textContent?.trim() ?? null,
  state: card.querySelector('.olc-state')?.textContent?.trim() ?? null,
  marks: [...card.querySelectorAll('[data-mark]')].map((m) => m.textContent.trim()),
})));
for (const [i, el] of (await desk.locator('.orbit-link-card').all()).entries()) await el.screenshot({ path: path.join(out, `linkcard-${String(i + 1).padStart(2, '0')}.png`) });

// The public shared page and Shared with me / the guest page.
const anon = await page(null, { width: 900, height: 600 });
const guestPage = await page(world.guestEmail, { width: 1440, height: 2600 });
await settle(guestPage, 3_000);
await shot(guestPage, 'shared-with-me', { fullPage: true });
const guestRows = await guestPage.evaluate(() => [...document.querySelectorAll('.tp-guest-session-sub')].map((e) => ({
  title: e.parentElement?.querySelector('.tp-label')?.textContent?.trim() ?? null,
  sub: e.textContent.trim(),
})));
for (const [label, c] of Object.entries(cases)) {
  if (!c.publicId) continue;
  const link = await api(`/sessions/${c.publicId}/share`, { method: 'POST' });
  await anon.goto(`${origin}/s/${link.shareToken}`);
  await anon.waitForSelector('.status-pill', { timeout: 30_000 }).catch(() => {});
  await settle(anon, 700);
  const READ_HEAD = () => {
    const pill = document.querySelector('.status-pill');
    return pill ? { word: pill.textContent.trim(), marks: [...pill.parentElement.querySelectorAll('[data-mark]')].map((m) => m.textContent.trim()) } : null;
  };
  c.sharedPage = await anon.evaluate(READ_HEAD);
  await shot(anon, `shared-${slug(label)}`, { clip: { x: 0, y: 0, width: 900, height: 140 } });
  // A loaded host can take longer than one wait to draw the head: read again after a reload before calling it missing.
  for (let attempt = 0; attempt < 3 && !c.guestPage; attempt += 1) {
    await guestPage.goto(`${origin}/sessions/${c.publicId}`);
    await guestPage.waitForSelector('.status-pill', { timeout: 20_000 }).catch(() => {});
    await settle(guestPage, 700);
    c.guestPage = await guestPage.evaluate(READ_HEAD);
  }
}

await desk.goto(`${origin}/`);
await desk.waitForSelector('.session-row', { timeout: 30_000 });
await desk.evaluate(() => window.dispatchEvent(new Event('orbit:open-session-search')));
const box = desk.locator('input[placeholder*="earch"]').last();
await box.fill('payloads');
await desk.waitForSelector('.ssearch-row', { timeout: 15_000 }).catch(() => {});
await settle(desk, 2_500);
const palette = await desk.evaluate(`[...document.querySelectorAll('.ssearch-row')].map(${READ})`);
await shot(desk, 'search');
// Each case by its own title: the row's state icon, the word beside it and the chips it draws.
for (const [label, c] of Object.entries(cases)) {
  if (!c.publicId) continue;
  await box.fill(c.title);
  const row = desk.locator('.ssearch-row', { has: desk.locator('.ssearch-title', { hasText: new RegExp(`^${c.title.replace(/[()]/g, '\\$&')}$`) }) }).first();
  await row.waitFor({ timeout: 20_000 }).catch(() => {});
  await settle(desk, 500);
  if (!(await row.count())) {
    // What the palette held instead, for whoever reads the miss.
    c.searchMiss = await desk.locator('.ssearch-row, .ssearch-empty').allTextContents();
    await shot(desk, `search-miss-${slug(label)}`);
    continue;
  }
  c.search = await row.evaluate((r) => ({
    state: r.querySelector('[data-state]')?.getAttribute('data-state') ?? null,
    word: r.querySelector('.ssearch-meta > span:not(.ssearch-workspace):not(.ssearch-in):not(.session-marks)')?.textContent?.trim() ?? null,
    marks: [...r.querySelectorAll('[data-mark]')].map((m) => m.textContent.trim()),
  }));
  await row.screenshot({ path: path.join(out, `search-${slug(label)}.png`) });
}
await browser.close();

for (const c of Object.values(cases)) {
  c.card = cards.find((k) => k.title === c.title) ?? null;
  c.guestRowText = guestRows.find((g) => g.title === c.title)?.sub ?? null;
}
// ---- held to the board ----
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const STATE_OF = { PENDING: 'Queued', RUNNING: 'Running', IDLE: 'Idle' };
const mismatches = [];
const checked = {};
for (const [label, c] of Object.entries(cases)) {
  if (c.missing) { mismatches.push(`${label}: missing ${c.missing}`); continue; }
  const e = c.expect;
  const check = (surface, ok, got) => {
    checked[surface] = (checked[surface] ?? 0) + 1;
    if (!ok) mismatches.push(`${label}: ${surface} drew ${JSON.stringify(got)}, board says ${e.state} ${JSON.stringify(e.marks)}`);
  };
  check('list row', !!c.listRow && STATE_OF[c.listRow.state] === e.state && same(c.listRow.marks, e.marks), c.listRow);
  check('header', !!c.header?.text.startsWith(e.state) && same(c.header.marks, e.marks), c.header);
  const run = c.taskPanel?.runs[0];
  check('task run', !!run && run.badge === e.state && same(run.marks, e.marks), run);
  check('link card', !!c.card && c.card.state === e.state && same(c.card.marks, e.marks), c.card);
  check('shared page', !!c.sharedPage && c.sharedPage.word === e.state && same(c.sharedPage.marks, e.marks), c.sharedPage);
  check('guest page', !!c.guestPage && c.guestPage.word === e.state && same(c.guestPage.marks, e.marks), c.guestPage);
  check('shared with me', !!c.guestRowText?.endsWith([e.state, ...e.marks].join(' · ')), c.guestRowText);
  check('search', !!c.search && c.search.word === e.state && STATE_OF[c.search.state] === e.state && same(c.search.marks, e.marks), c.search);
  // The Tasks list pill speaks for a live run only (a finished or parked-without-wake run reads the task's own word).
  const pill = pills.find((x) => x.title === c.taskTitle);
  c.pill = pill ?? null;
  if (pill && ['Queued', 'Running', 'Idle'].includes(pill.word)) check('tasks pill', pill.word === e.state && same(pill.marks, e.marks), pill);
}
const result = { at: new Date().toISOString(), cases, pills, palette, checked, mismatches };
fs.writeFileSync(path.join(out, 'walk.json'), JSON.stringify(result, null, 1));
console.log(`checked ${JSON.stringify(checked)}`);
console.log(`pills: ${JSON.stringify(pills)}`);
console.log(`palette (first 5): ${JSON.stringify(palette.slice(0, 5))}`);
console.log(mismatches.length ? `MISMATCHES ${mismatches.length}:\n${mismatches.join('\n')}` : 'every web surface matches the board');
