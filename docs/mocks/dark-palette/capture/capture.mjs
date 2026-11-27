// Real-build shots of the dark session page, today and with the proposed palette overrides injected.
// Not a test. Run against `vite preview` of a fresh build of this tree:
//   node docs/mocks/dark-palette/capture/capture.mjs <outDir> [baseURL] [fontDir]
// fontDir holds Inter.ttf and NotoSansSC.ttf; they stand in for SF and PingFang as on a Mac.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(here, '../../../..');
const { chromium } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, WORKSPACE, RUNNER } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);
const { uuidToBase62 } = await import(`${WT}/src/shared/dist/index.js`);

const [out, baseURL = 'http://127.0.0.1:4691', fontDir = '/mnt/tmp/acp-mock/fonts'] = process.argv.slice(2);
if (!out) throw new Error('usage: capture.mjs <outDir> [baseURL] [fontDir]');
mkdirSync(out, { recursive: true });
const proposal = readFileSync(path.join(here, 'proposal.css'), 'utf8');

const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const T = (min) => new Date(Date.parse('2026-09-28T12:00:00.000Z') - min * 60_000).toISOString();
const ws = (n, name, extra = {}) => ({ ...WORKSPACE, id: id(n), name, runnerId: RUNNER.id, ...extra });
const workspaces = [
  { ...WORKSPACE, name: 'orbit-ws01' },
  ws(2001, 'orbit-ws02'), ws(2002, 'orbit-ws04'), ws(2003, 'orbit-ws05'), ws(2004, 'orbit-prod'),
  ws(2005, 'wikova-data'), ws(2006, 'kiktok'), ws(2007, 'HPC'),
];
const counts = [
  { workspaceId: WORKSPACE.id, active: 2, running: 2, jobs: 1, needsYou: 73 },
  { workspaceId: id(2002), active: 0, running: 0, jobs: 0, needsYou: 28 },
  { workspaceId: id(2003), active: 0, running: 0, jobs: 0, needsYou: 8 },
  { workspaceId: id(2005), active: 0, running: 0, jobs: 0, needsYou: 14 },
];
const row = (n, title, min, extra = {}) => ({
  ...SESSION, id: id(n), title, lastTurnAt: T(min), updatedAt: T(min), folderId: null, ...extra,
});
const sessions = [
  { ...SESSION, title: 'Review the dark mode palette', lastTurnAt: T(0), updatedAt: T(0), status: 'RUNNING', runState: 'RUNNING' },
  row(101, 'Session list stays fast with thousands of rows', 1, { status: 'RUNNING', runState: 'RUNNING' }),
  row(102, 'Header share and menu buttons', 2, { status: 'RUNNING', runState: 'RUNNING' }),
  row(103, 'Browser notifications in Settings search', 46),
  row(104, 'Menu style polish', 29),
  row(105, 'Check the minimax configuration error', 18),
  row(106, 'Translate project criteria and title', 60 * 26),
];
const TURN = id(4001);
const events = [
  { seq: 1, type: 'user', payload: { text: 'Please help me review the color scheme of this dark mode.' }, turnId: TURN, ts: T(5) },
  { seq: 2, type: 'assistant', payload: { text: [
    'Overall the dark mode **works**. It uses a neutral grey with a slight cool tint, and the text is not pure white.',
    '',
    '| Surface | Token | Colour |',
    '|---|---|---|',
    '| Sidebar | `--bg-sunken` | #17171a |',
    '| Page | `--bg-base` | #202023 |',
    '| Composer | `--bg-raised` | #2b2b2e |',
    '',
    'The steps between layers are small: the sidebar is only 1.10:1 darker than the page, and `--bg-subtle` is 1.06:1.',
    '',
    '- Secondary text (`--text-4`) is 3.56:1 on the page.',
    '- Blue means selection, the primary action, your message and links.',
    '',
    'See [the token file](https://example.test) for the full list.',
  ].join('\n') }, turnId: TURN, ts: T(4) },
  { seq: 3, type: 'turn_end', payload: {}, turnId: TURN, ts: T(4) },
];

const fontInit = () => {
  const s = document.createElement('style');
  s.textContent = `@font-face{font-family:BlinkMacSystemFont;src:url(/__mockfonts/Inter.ttf);font-weight:100 900}
@font-face{font-family:-apple-system;src:url(/__mockfonts/Inter.ttf);font-weight:100 900}
@font-face{font-family:'PingFang SC';src:url(/__mockfonts/NotoSansSC.ttf);font-weight:100 900}`;
  document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s));
};

const browser = await chromium.launch();
const report = {};
for (const variant of ['today', 'proposal']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, baseURL, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await page.addInitScript(fontInit);
  await page.route('**/__mockfonts/**', (r) => r.fulfill({ body: readFileSync(path.join(fontDir, path.basename(new URL(r.request().url()).pathname))), contentType: 'font/ttf' }));
  await installFixedDate(page);
  await installFixtures(page, { theme: 'dark' });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (req.method() !== 'GET') return route.fallback();
    if (p === '/api/workspaces') return json(workspaces);
    if (p === '/api/sessions/counts') return json(counts);
    if (p === '/api/sessions') return json(sessions);
    if (p === `/api/sessions/${SESSION.id}`) return json(sessions[0]);
    if (p === `/api/sessions/${SESSION.id}/events/page`) return json({ events, hasMore: false });
    return route.fallback();
  });
  await page.goto(`/sessions/${SESSION.id}`);
  await page.locator('#boot').waitFor({ state: 'detached' }).catch(() => {});
  await page.locator('.session-col-list .session-row').first().waitFor();
  await page.getByText('Overall the dark mode').waitFor();
  if (variant === 'proposal') await page.addStyleTag({ content: proposal });
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${variant}.png` });
  // Which element paints each surface, and with what, at a few points of the 1440x860 page.
  report[variant] = await page.evaluate((pts) => Object.fromEntries(Object.entries(pts).map(([k, [x, y]]) => {
    let el = document.elementFromPoint(x, y);
    while (el && getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)') el = el.parentElement;
    const cls = el ? `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` : 'none';
    return [k, `${el ? getComputedStyle(el).backgroundColor : ''} ${cls}`];
  })), { nav: [150, 600], gutter: [276, 600], list: [440, 760], main: [1000, 560], code: [770, 251], composer: [800, 790] });
  await context.close();
}
await browser.close();
writeFileSync(`${out}/computed.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
