// Landing session page evidence (task 34a140SNCzzuYh9InlvnA): the BUILT console (dist/) served
// statically, the repo's REST fixtures (src/web/ui-migration) for the shell and sign-in, and the
// landing session overridden per frame — the board docs/mocks/landing-session/v4/05 frames the web
// half shows. Writes <frame>.png per frame (the workspace pane, or the viewport when a menu is
// open), plus report.json with what each frame drew and any fixture call left unhandled.
//
// RUN (dist built first, from the session worktree):
//   cd <wt>/src/web && npx vite build --outDir /var/tmp/ls-shots/dist --emptyOutDir
//   FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c 'ip link set lo up && cd /var/tmp/ls-shots && node capture.mjs'
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WT = process.env.WT ?? '/root/.orbit/worktrees/b6f79709-65b3-5d50-b111-1a5535f2d332';
const KIT = '/var/tmp/ls-shots';
const DIST = `${KIT}/dist`;
const OUT = process.argv[2] ?? `${KIT}/out`;
const PORT = 5897;
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, SESSION_PATH } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let file = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// 14:58:30 in Asia/Shanghai on 2026-09-25 — the board's frame i clock (14:58).
const NOW = Date.parse('2026-09-25T06:58:30.000Z');
const SEC = 1_000, MIN = 60 * SEC;
const ago = (ms) => new Date(NOW - ms).toISOString();
const at = (iso) => iso;
async function fixDate(page) {
  await page.addInitScript((timestamp) => {
    window.Date = new Proxy(Date, {
      construct: (D, args) => Reflect.construct(D, args.length ? args : [timestamp]),
      apply: (D) => new D(timestamp).toString(),
      get: (D, key) => key === 'now' ? () => timestamp : Reflect.get(D, key),
    });
  }, NOW);
}

const PROJECT = '34bmzOkov3xN2yLPrnsCk';
const LANDING_ID = SESSION.id;
const RUNNER = 'workstation-gpu';
const TASK = '维护每日轮数上限在服务端路径上没生效：byJob 计数恒为 0（SQL 三值逻辑，10-10 修）';
const BRANCH = 'project/34bmzOkov3xN2yLPrnsCk';
const entry = (o) => ({ id: o.id, seq: o.seq, kind: o.kind, at: o.at, claim: o.claim ?? 0, round: o.round ?? null,
  check: o.check ?? null, phase: o.phase ?? null, step: null, actor: o.actor ?? null, reason: o.reason ?? null,
  data: o.data ?? null, text: o.text, ...(o.derived ? { derived: true } : {}) });
const attempt = (o = {}) => ({
  jobId: 'job-landing', kind: 'LAND_TASK', state: 'RUNNING', generation: 2, phase: 'CHECK', round: 1, step: null,
  claim: 1, runnerName: RUNNER, sourceSessionId: SESSION.id, targetRef: `refs/heads/${BRANCH}`,
  startedAt: ago(2 * MIN + 40 * SEC), heartbeatAt: ago(2 * SEC), outputMovedAt: ago(3 * SEC),
  progressProtocol: 'v2', check: { name: 'MERGE_CHECK', index: 1, count: 3, budgetSeconds: 3_600, startedAt: ago(2 * MIN + 40 * SEC) },
  liveness: 'LIVE', blockingReason: null, timedOut: false, limitSeconds: 600,
  retryable: false, pushBoundaryPassed: false, ...o,
});
const landing = (o = {}) => ({
  sessionId: LANDING_ID, projectId: PROJECT, subject: 'TASK', taskId: 'task-landing', promotionId: null,
  episode: 1, openedAt: ago(38 * MIN), settledAt: null, settledAs: null, phase: 'CHECK', round: 1,
  checks: [], liveness: 'LIVE', blockingReason: null, currentAttempt: attempt(), todos: [], generations: [],
  timeline: { sections: [], facts: [], truncated: false }, ...o,
});
const generation2 = (entries) => ({
  sections: [{
    title: 'Generation 2', jobId: 'job-landing', kind: 'LAND_TASK', generation: 2, state: 'RUNNING', entries,
  }], facts: [], truncated: false,
});
const timeoutTimeline = generation2([
  entry({ id: 'e1', seq: 1, kind: 'ENQUEUED', at: '2026-09-25T06:20:00Z', text: 'Task marked done again · queued',
    reason: 'The coordinator sent it back at 11:34 (task_reopen)' }),
  entry({ id: 'e2', seq: 2, kind: 'CLAIMED', at: '2026-09-25T06:33:00Z', claim: 1, actor: { type: 'RUNNER' },
    text: `Claimed by runner ${RUNNER} · claim 1`, reason: 'Reports every 30 s (v2)' }),
  entry({ id: 'e3', seq: 3, kind: 'STEP', at: '2026-09-25T06:34:00Z', claim: 1, phase: 'FETCH', actor: { type: 'RUNNER' },
    text: 'Fetched · synced main' }),
  entry({ id: 'e4', seq: 4, kind: 'STEP', at: '2026-09-25T06:35:00Z', claim: 1, phase: 'REBASE', actor: { type: 'RUNNER' },
    text: `Rebasing onto ${BRANCH}`, reason: 'Last report' }),
]);
const liveTimeline = generation2([
  entry({ id: 'e1', seq: 1, kind: 'ENQUEUED', at: '2026-09-25T06:55:00Z', text: 'Task marked done · queued to land on project/p1' }),
  entry({ id: 'e2', seq: 2, kind: 'CLAIMED', at: '2026-09-25T06:55:50Z', claim: 1, actor: { type: 'RUNNER' },
    text: `Claimed by runner ${RUNNER} · claim 1` }),
  entry({ id: 'e3', seq: 3, kind: 'CHECK_STARTED', at: '2026-09-25T06:55:50Z', claim: 1, phase: 'CHECK',
    check: { name: 'MERGE_CHECK', index: 1 }, actor: { type: 'RUNNER' }, text: 'Merge check started · claim 1 · ' + RUNNER }),
]);
const mergedPromo = {
  promotionId: 'promo-1', state: 'MERGED', sourceKind: 'PROJECT_BRANCH',
  sourceRef: `refs/heads/${BRANCH}`, sourceSha: 'a'.repeat(40), upstreamRef: 'refs/heads/main',
  commitsAhead: 2, filesChanged: 3,
  tasks: [{ taskId: 'task-1', title: '维护每日轮数上限在服务端路径上没生效' }, { taskId: 'task-2', title: 'P10 · 本部署切换' }],
  taskIds: ['task-1', 'task-2'], checks: [], conflicts: [], blockedReason: null,
  upstreamShaChecked: 'b'.repeat(40), landsTreeSha: '5e5bfca' + '0'.repeat(33), landsAs: 'MERGE_COMMIT',
  askedAt: null, upstream: { syncedAt: null, conflicts: false }, recheckedAt: null, recheck: null,
  merged: { sha: '8ed0ea7' + '0'.repeat(33), at: '2026-09-25T01:51:00Z', automatic: true, byUserId: null },
};
const mergeTimeline = {
  sections: [
    { title: 'Merge check · 1', jobId: 'job-c1', kind: 'CHECK_PROMOTION', generation: 1, state: 'READY', entries: [
      entry({ id: 'm1', seq: 1, kind: 'ENQUEUED', at: '2026-09-25T01:14:00Z', text: `Merge check queued · ${BRANCH} → main` }),
      entry({ id: 'm2', seq: 2, kind: 'CHECK_FINISHED', at: '2026-09-25T01:31:00Z', claim: 1, check: { name: 'MERGE_CHECK', index: 1 },
        actor: { type: 'RUNNER' }, text: 'Merge check passed · 17m 02s' }),
    ] },
    { title: 'Merge to main · 1', jobId: 'job-l1', kind: 'LAND_PROMOTION', generation: 1, state: 'MERGED', entries: [
      entry({ id: 'm3', seq: 3, kind: 'CONFIRMATION', at: '2026-09-25T01:50:00Z', actor: { type: 'AUTOMATIC' }, text: 'Confirmed by Automatic' }),
      entry({ id: 'm4', seq: 4, kind: 'RESULT', at: '2026-09-25T01:51:00Z', claim: 1, phase: 'PUSH', actor: { type: 'RUNNER' }, text: 'Landed on main · 8ed0ea7' }),
    ] },
  ], facts: [{ kind: 'PROMOTION_STATE', text: 'Merge round · merged', data: null }], truncated: false,
};
const detail = (landingView, title) => ({
  ...SESSION, taskId: null, title, sessionKind: 'LANDING', landing: landingView,
  status: landingView.settledAt ? 'SUCCEEDED' : 'AWAITING_INPUT',
  runState: landingView.settledAt ? 'SUCCEEDED' : 'AWAITING_INPUT',
});

const FRAMES = {
  // 05 a — a merge round checking (Renamed here as the task segment's LIVE card uses the same V6).
  'a-live': {
    title: `Land · ${TASK}`,
    landing: landing({ timeline: liveTimeline }),
    integration: { upstreamRef: 'refs/heads/main', inFlightJobs: [{ jobId: 'job-landing', stepStartedAt: ago(2 * MIN + 40 * SEC), typicalMs: 18 * 60_000 }], landTasks: [] },
    promotions: null, merged: [], menu: false,
  },
  // 05 web — the task segment's timeout, ⋯ menu open (the board's one web frame).
  'i-timeout-menu': {
    title: `Land · ${TASK}`,
    landing: landing({
      currentAttempt: attempt({ state: 'RUNNING', phase: 'REBASE', liveness: 'LEASE_EXPIRED', timedOut: true,
        retryable: true, startedAt: '2026-09-25T06:33:00Z', heartbeatAt: '2026-09-25T06:35:00Z' }),
      timeline: timeoutTimeline,
    }),
    integration: { upstreamRef: 'refs/heads/main', inFlightJobs: [], landTasks: [] },
    promotions: null, merged: [], menu: true,
  },
  // A merge round checking, with the on-pass sentence and its menu.
  'd-merge-menu': {
    title: `Merge ${BRANCH} → main · #9`,
    landing: landing({
      subject: 'PROMOTION', taskId: null, promotionId: 'promo-1',
      currentAttempt: attempt({ kind: 'LAND_PROMOTION', phase: 'CHECK', claim: 1 }),
      timeline: { sections: [{ title: 'Merge to main · 1', jobId: 'job-landing', kind: 'LAND_PROMOTION', generation: 1,
        state: 'RUNNING', entries: [entry({ id: 'd1', seq: 1, kind: 'ENQUEUED', at: '2026-09-25T03:34:00Z', text: 'Queued to merge into main' })] }], facts: [], truncated: false },
    }),
    integration: { upstreamRef: 'refs/heads/main', inFlightJobs: [{ jobId: 'job-landing', stepStartedAt: ago(2 * MIN + 40 * SEC), typicalMs: 18 * 60_000 }], landTasks: [] },
    promotions: { ...mergedPromo, state: 'CONFIRMED', merged: null, landsTreeSha: null, onPass: null },
    merged: [], menu: true,
  },
  // 05 e — a merge check timed out (Re-run the check and Abandon).
  'e-check-timeout': {
    title: `Merge ${BRANCH} → main · #7`,
    landing: landing({
      subject: 'PROMOTION', taskId: null, promotionId: 'promo-1',
      currentAttempt: attempt({ kind: 'CHECK_PROMOTION', phase: 'CHECK', liveness: 'LEASE_EXPIRED', timedOut: true,
        startedAt: '2026-09-25T06:02:00Z', heartbeatAt: '2026-09-25T06:02:00Z', check: { name: 'MERGE_CHECK', index: 1, count: 1, budgetSeconds: 600, startedAt: '2026-09-25T06:02:00Z' } }),
      timeline: { sections: [{ title: 'Merge check · 1', jobId: 'job-landing', kind: 'CHECK_PROMOTION', generation: 1, state: 'RUNNING',
        entries: [entry({ id: 't1', seq: 1, kind: 'CLAIMED', at: '2026-09-25T06:02:00Z', claim: 1, actor: { type: 'RUNNER' }, text: `Claimed by runner ${RUNNER} · claim 1` })] }], facts: [], truncated: false },
    }),
    integration: { upstreamRef: 'refs/heads/main', inFlightJobs: [], landTasks: [] },
    promotions: { ...mergedPromo, state: 'CHECKING', merged: null, landsTreeSha: null, onPass: 'MERGE' },
    merged: [], menu: false,
  },
  // 05 c — the settled merge round.
  'c-merged': {
    title: `Merge ${BRANCH} → main · #9`,
    landing: landing({
      subject: 'PROMOTION', taskId: null, promotionId: 'promo-1', episode: 9,
      settledAt: '2026-09-25T01:51:00Z', settledAs: 'MERGED', liveness: null,
      currentAttempt: attempt({ kind: 'LAND_PROMOTION', state: 'MERGED', phase: 'PUSH', liveness: null,
        startedAt: '2026-09-25T01:50:00Z', heartbeatAt: '2026-09-25T01:51:00Z' }),
      checks: [{ name: 'MERGE_CHECK', exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 17 * 60_000 + 41_000 }],
      timeline: mergeTimeline,
    }),
    integration: { upstreamRef: 'refs/heads/main', inFlightJobs: [], landTasks: [] },
    promotions: null, merged: [mergedPromo], menu: false,
  },
};

const browser = await chromium.launch();
const report = [];
for (const theme of ['light', 'dark']) {
  for (const [name, frame] of Object.entries(FRAMES)) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2, timezoneId: 'Asia/Shanghai',
    });
    page.on('pageerror', (e) => console.log('PAGEERROR', name, theme, e.message));
    await fixDate(page);
    const fixtures = await installFixtures(page, { theme });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (route.request().method() === 'GET') {
        if (pathname === `/api${SESSION_PATH}`) return route.fulfill({ json: detail(frame.landing, frame.title) });
        if (pathname === `/api/projects/${PROJECT}/integration`) return route.fulfill({ json: frame.integration });
        if (pathname === `/api/projects/${PROJECT}/coordinator/status`) {
          return route.fulfill({ json: { coordination: { sessionId: SESSION.id }, readAt: new Date(NOW).toISOString() } });
        }
        if (pathname === `/api/projects/${PROJECT}/promotions/current`) return route.fulfill({ json: frame.promotions });
        if (pathname === `/api/projects/${PROJECT}/promotions/merged`) return route.fulfill({ json: frame.merged ?? [] });
        if (pathname === `/api${SESSION_PATH}/landing/log`) {
          return route.fulfill({ json: { jobId: 'job-landing', entries: [{ jobId: 'job-landing', claim: 1, round: 1,
            check: { name: 'MERGE_CHECK', index: 1 }, seq: 0, truncatedBytes: 0, at: '2026-09-25T06:56:00Z',
            text: '$ npm test -w @orbit/apiserver\n ✔ wiki/wiki-daily-limit.spec.ts (412ms)\n ▶ projects/project-integration-line.spec.ts' }], nextCursor: null } });
        }
      }
      return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${PORT}${SESSION_PATH}`);
    await page.waitForSelector('.landing-page', { timeout: 20_000 });
    await page.waitForFunction(() => !document.getElementById('boot'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    if (frame.menu) {
      const trigger = page.locator('.landing-page-more');
      if (await trigger.count()) {
        await trigger.click();
        await page.waitForTimeout(400);
      }
    }
    const file = `${OUT}/${theme}-${name}.png`;
    if (frame.menu) {
      await page.screenshot({ path: file, animations: 'disabled' });
    } else {
      await page.locator('.workspace-view').screenshot({ path: file, animations: 'disabled' });
    }
    const drawn = await page.evaluate(() => ({
      title: document.querySelector('.landing-page-title')?.textContent,
      sub: document.querySelector('.landing-page-sub')?.textContent,
      head: [...document.querySelectorAll('.landing-head-line')].map((n) => n.textContent).join(' | '),
      detail: [...document.querySelectorAll('.landing-head-detail')].map((n) => n.textContent).join(' | '),
      card: document.querySelector('.landing-status-card')?.textContent,
      sections: [...document.querySelectorAll('.landing-timeline-heading')].map((n) => n.textContent),
      footer: document.querySelector('.landing-page-foot')?.textContent,
      menu: [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent),
      menuHtml: [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.innerHTML),
      composer: !!document.querySelector('.workspace-composer textarea'),
    }));
    report.push({ theme, frame: name, ...drawn, unhandled: fixtures.unhandled });
    console.log(theme, name, JSON.stringify(drawn), fixtures.unhandled.length ? `unhandled=${fixtures.unhandled.join(' ')}` : '');
    await page.close();
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
server.close();
