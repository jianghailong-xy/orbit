// Evidence for the P6-follow-up task: Activity's Plan card under server execution says
// `System model · about 1–2 hours` beside Draft plan. The real web page (vite, this branch) with a fake
// API, as board 35's screenshots were made — no deployment is switched for this.
//
//   node artifacts/plan-card-shot.mjs            # server execution (the shot the evidence needs)
//   node artifacts/plan-card-shot.mjs runner     # the same page under runner, for comparison
//
// Run from src/web so `playwright` resolves; the dev server must be up on PORT.
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 5273);
const OUT = process.env.OUT ?? '/root/.orbit/worktrees/9aa973d5-bcda-56fb-ae0c-e15685a950e9/artifacts';
const SERVER = process.argv[2] !== 'runner';
const SPACE_ID = '0196e100-0000-7000-8000-000000000001';
const NOW = '2026-10-08T09:00:00.000Z';
const DAY = 86_400_000;
const ago = (days) => new Date(Date.parse(NOW) - days * DAY).toISOString();

const SPACE = {
  id: SPACE_ID,
  slug: 'orbit',
  title: 'github-com-jianghailong-xy-orbit',
  repoUrlNorm: 'github.com/jianghailong-xy/orbit',
  rootCommitSha: 'b'.repeat(40),
  settings: { push: true, autoAcceptReinforce: true, maintenance: { enabled: true, mode: 'automatic', provider: 'local-vllm', workspaceId: null } },
  createdAt: ago(40),
  updatedAt: ago(2),
  pendingOps: 0,
  planWaiting: 0,
  workspaceIds: [],
  docs: { written: 0, total: 0 },
};

const HEALTH = {
  spaceId: SPACE_ID,
  entries: 137,
  maintenance: {
    look: 'ok', enabled: true, lastOkAt: ago(0.2), lastRunAt: ago(0.2), consecutiveFailures: 0, backlog: 0, oldestPendingAt: null,
    lagSeconds: 0, dailyLimitReached: false, held: null, running: null,
    lastRun: { sessionId: null, jobId: '34cE0job0000000000001', at: ago(0.2), ok: true },
    lastFailure: null,
  },
  executor: { mode: SERVER ? 'canary' : 'runner', serverExecutes: SERVER },
  ...(SERVER ? { systemModel: { state: 'up', model: 'qwen3.8-27b-fp8', since: ago(1), checkedAt: ago(0.01), workerSeenAt: ago(0.01) } } : {}),
};

/** No plan yet: the invitation whose line under Draft plan is what this shot is about. */
const PLAN = { spaceId: SPACE_ID, confirmed: null, draft: null, proposals: [], job: null };

function answer(path, params) {
  if (path === '/users/me') return { id: '0196e100-0000-7000-8000-0000000000ff', email: 'owner@example.com', name: 'wikova', createdAt: ago(60), role: 'OWNER' };
  if (path === '/auth/setup-status') return { needsSetup: false };
  if (path === '/workspaces') return [];
  if (path === '/runners') return [];
  if (path === '/agents') return [];
  if (path === '/providers') return [];
  if (path === '/projects') return [];
  if (path === '/projects/sidebar') return [];
  if (path === '/sessions/counts') return [];
  if (path === '/task-lists') return [];
  if (path === '/projects') return [];
  if (path === '/wiki/spaces') return [SPACE];
  if (path === `/wiki/spaces/${SPACE_ID}`) return { ...SPACE, usage: { days: 7, sessionsPushed: 692, searches: 0, gets: 0, entries: [] } };
  if (path === `/wiki/spaces/${SPACE_ID}/health`) return HEALTH;
  if (path === `/wiki/spaces/${SPACE_ID}/plan`) return PLAN;
  if (path === `/wiki/spaces/${SPACE_ID}/docs`) return { spaceId: SPACE_ID, plan: null, docs: { total: 0, written: 0 }, categories: [] };
  if (path === `/wiki/spaces/${SPACE_ID}/articles`) return { spaceId: SPACE_ID, categories: [], uncategorized: [] };
  if (path === `/wiki/spaces/${SPACE_ID}/entries`) return [];
  if (path === `/wiki/spaces/${SPACE_ID}/timeline`) return { items: [] };
  if (path === `/wiki/spaces/${SPACE_ID}/jobs`) return { spaceId: SPACE_ID, jobs: [] };
  if (path === `/wiki/spaces/${SPACE_ID}/plan/versions`) return { spaceId: SPACE_ID, versions: [] };
  if (path === '/wiki/review') return [];
  if (path === '/wiki/system-model') {
    return SERVER
      ? { state: 'up', model: 'qwen3.8-27b-fp8', since: ago(1), checkedAt: ago(0.01), workerSeenAt: ago(0.01), executor: { mode: 'canary', serverExecutes: true } }
      : null;
  }
  return undefined;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
page.on('console', (message) => { if (message.type() === 'error') console.log('page error:', message.text()); });
page.on('pageerror', (error) => console.log('uncaught:', error.message, '\n', String(error.stack).split('\n').slice(0, 6).join('\n')));
await page.addInitScript((token) => {
  localStorage.setItem('orbit_token', token);
  localStorage.setItem('orbit_refresh', 'x.y.z');
}, `x.${Buffer.from(JSON.stringify({ sub: '0196e100-0000-7000-8000-0000000000ff', email: 'owner@example.com' })).toString('base64url')}.y`);
await page.route('**/api/**', (route) => {
  const url = new URL(route.request().url());
  const body = answer(url.pathname.replace(/^\/api/, ''), url.searchParams);
  if (body === undefined) {
    console.log('unanswered:', url.pathname);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not in this fake"}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

await page.goto(`http://localhost:${PORT}/wiki/orbit/activity`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if (!(await page.locator('.wk-plan-card').count())) {
  writeFileSync(`${OUT}/debug.html`, await page.content());
  await page.screenshot({ path: `${OUT}/debug.png`, fullPage: true });
  console.log('no Plan card yet: wrote debug.html and debug.png');
  console.log('url:', page.url());
  console.log('text:', JSON.stringify((await page.locator('body').innerText()).slice(0, 400)));
}
await page.waitForSelector('.wk-plan-card', { timeout: 30_000 });
const note = await page.locator('.wk-plan-card .hint').first().innerText();
const foot = await page.locator('.wk-plan-card .wk-rv-foot').first().innerHTML();
const banner = await page.locator('.wk-plan-card .wk-plan-card-text').first().innerText();
const toasts = await page.locator('.ant-message-notice, .ant-notification-notice').count();
console.log('the Plan card\'s line:', JSON.stringify(note));
console.log('Draft plan beside it:', /Draft plan/.test(foot));
console.log('the card\'s sentence:', JSON.stringify(banner));
console.log('toasts on screen:', toasts);

const name = SERVER ? 'activity-plan-server' : 'activity-plan-runner';
await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
await page.locator('.wk-plan-card').screenshot({ path: `${OUT}/${name}-card.png` });
let notes =
  `URL: /wiki/orbit/activity\nexecutor: ${SERVER ? 'canary (serverExecutes: true)' : 'runner (serverExecutes: false)'}\n`
  + `Plan card line: ${note}\nDraft plan beside it: ${/Draft plan/.test(foot)}\nCard sentence: ${banner}\nToasts: ${toasts}\n\n`
  + `The Plan card's foot as the DOM has it:\n${foot}\n`;

// The plan's empty page: who drafts it, and the note under Draft plan — the other two sentences the review named.
await page.goto(`http://localhost:${PORT}/wiki/orbit/plan`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.wk-pl-empty', { timeout: 30_000 });
const body = await page.locator('.wk-pl-empty p').first().innerText();
const emptyNote = await page.locator('.wk-pl-empty .note').first().innerText();
console.log('the empty page\'s body:', JSON.stringify(body));
console.log('the empty page\'s note:', JSON.stringify(emptyNote));
const planName = SERVER ? 'plan-empty-server' : 'plan-empty-runner';
await page.screenshot({ path: `${OUT}/${planName}.png`, fullPage: true });
await page.locator('.wk-pl-empty').screenshot({ path: `${OUT}/${planName}-card.png` });
notes += `\nURL: /wiki/orbit/plan\nEmpty page body: ${body}\nEmpty page note: ${emptyNote}\n`;
writeFileSync(`${OUT}/${name}.txt`, notes);
await browser.close();
