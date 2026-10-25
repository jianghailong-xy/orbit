// Landing page fixes on the web console (task 34jQkOSz5CENWMRYAWVHC): the landing page's result line
// for a merge check that ended READY, item 1. Copied from the landing page kit
// (docs/evidence/landing-session-web/kit/capture.mjs, task 34a140SNCzzuYh9InlvnA): the BUILT console
// (dist/) served statically, the repo's REST fixtures (src/web/ui-migration) for the shell and
// sign-in, and the landing session overridden per frame. Against docs/mocks/landing-session/v4/05:
//   ready        a merge check that passed and ended READY: `Ready to merge into main` draws ✓
//   ready-round  the same round handed back once: check READY ✓, then a merge to main whose main
//                moved answers READY ✗ (M-T12, J-T13, unchanged), then the check again, READY ✓
// Writes <theme>-<frame>.png per frame, plus report.json with every timeline line's mark (glyph and
// class) beside its text, and any fixture call left unhandled.
//
// RUN: see ../README.md (dist built first from the session worktree).
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WT = process.env.WT ?? '/root/.orbit/worktrees/b8dff478-fb07-57c8-b77f-62e2293a3b53';
const KIT = process.env.KIT ?? '/var/tmp/lpf-shots';
const DIST = `${KIT}/dist`;
const OUT = process.argv[2] ?? `${KIT}/out`;
const PORT = 5898;
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

const PASSED = { exitCode: 0, expectedExitCode: 0, timedOut: false };
// The server's lines for one merge check that passed and ended READY (resultText: `Ready to merge
// into main`, data.state READY), then the owner's question (handedToText).
const checkSection = (n, job, start) => {
  const t = (m) => new Date(Date.parse(start) + m * MIN).toISOString();
  return { title: `Merge check · ${n}`, jobId: job, kind: 'CHECK_PROMOTION', generation: n, state: 'READY', entries: [
    entry({ id: `${job}-1`, seq: 1, kind: 'ENQUEUED', at: t(0), text: `Merge check queued · ${BRANCH} → main` }),
    entry({ id: `${job}-2`, seq: 2, kind: 'CLAIMED', at: t(0.5), claim: 1, actor: { type: 'RUNNER' }, text: `Claimed by runner ${RUNNER} · claim 1` }),
    entry({ id: `${job}-3`, seq: 3, kind: 'ROUND', at: t(0.5), claim: 1, round: 1, actor: { type: 'RUNNER' }, data: { round: 1 }, text: 'Round 1' }),
    entry({ id: `${job}-4`, seq: 4, kind: 'STEP', at: t(1), claim: 1, phase: 'FETCH', actor: { type: 'RUNNER' }, text: 'Fetched · synced main' }),
    entry({ id: `${job}-5`, seq: 5, kind: 'CHECK_STARTED', at: t(1.2), claim: 1, round: 1, phase: 'CHECK',
      check: { name: 'MERGE_CHECK', index: 1 }, actor: { type: 'RUNNER' }, text: `Merge check started · claim 1 · ${RUNNER}` }),
    entry({ id: `${job}-6`, seq: 6, kind: 'CHECK_FINISHED', at: t(18), claim: 1, round: 1, phase: 'CHECK',
      check: { name: 'MERGE_CHECK', index: 1 }, actor: { type: 'RUNNER' }, data: PASSED, text: 'Merge check passed · 17m 02s' }),
    entry({ id: `${job}-7`, seq: 7, kind: 'RESULT', at: t(18), claim: 1, phase: 'CHECK', actor: { type: 'RUNNER' },
      data: { state: 'READY', requestedState: 'READY', errorCode: null }, text: 'Ready to merge into main' }),
    entry({ id: `${job}-8`, seq: 8, kind: 'HANDED_TO', at: t(18), actor: { type: 'PLATFORM' },
      data: { assignee: 'OWNER', itemKind: 'PROMOTION_APPROVAL' }, text: 'Asked the owner to merge into main' }),
  ] };
};
// A merge to main whose push was refused because main moved: it answers READY, hands the candidate
// back, and the round is checked again. Merged nothing (M-T12, J-T13), so its result keeps its ✗.
const handedBack = {
  title: 'Merge to main · 1', jobId: 'job-l1', kind: 'LAND_PROMOTION', generation: 1, state: 'READY', entries: [
    entry({ id: 'l1', seq: 1, kind: 'CONFIRMATION', at: '2026-09-25T06:00:00Z', actor: { type: 'OWNER' }, text: 'Merge to main confirmed by the owner' }),
    entry({ id: 'l2', seq: 2, kind: 'ENQUEUED', at: '2026-09-25T06:00:00Z', text: 'Queued to merge into main' }),
    entry({ id: 'l3', seq: 3, kind: 'CLAIMED', at: '2026-09-25T06:00:30Z', claim: 1, actor: { type: 'RUNNER' }, text: `Claimed by runner ${RUNNER} · claim 1` }),
    entry({ id: 'l4', seq: 4, kind: 'PUSH_REFUSED', at: '2026-09-25T06:02:00Z', claim: 1, phase: 'PUSH', actor: { type: 'RUNNER' },
      text: 'Push refused · main moved 1 commit, 1 from outside the queue (fix(web): a table that scrolls)' }),
    entry({ id: 'l5', seq: 5, kind: 'RESULT', at: '2026-09-25T06:02:00Z', claim: 1, phase: 'PUSH', actor: { type: 'RUNNER' },
      data: { state: 'READY', requestedState: 'READY', errorCode: null }, text: 'Ready to merge into main' }),
    entry({ id: 'l6', seq: 6, kind: 'RECHECK_ON_MOVED_MAIN', at: '2026-09-25T06:02:00Z', actor: { type: 'PLATFORM' },
      text: 'main moved 1 commit since the check — checking again on the new main' }),
  ],
};
const readyPromo = { ...mergedPromo, state: 'READY', merged: null, onPass: 'ASK', askedAt: '2026-09-25T06:38:00Z' };
const readyLanding = (sections, episode) => landing({
  subject: 'PROMOTION', taskId: null, promotionId: 'promo-1', episode, liveness: null,
  currentAttempt: attempt({ jobId: sections[sections.length - 1].jobId, kind: 'CHECK_PROMOTION', state: 'READY',
    generation: sections.length, check: null, liveness: null, startedAt: '2026-09-25T06:20:00Z', heartbeatAt: '2026-09-25T06:38:00Z' }),
  checks: [{ name: 'MERGE_CHECK', exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 17 * 60_000 + 2_000 }],
  timeline: { sections, facts: [], truncated: false },
});

const FRAMES = {
  'ready': {
    title: `Merge ${BRANCH} → main · #9`,
    landing: readyLanding([checkSection(1, 'job-c1', '2026-09-25T06:20:00Z')], 9),
    integration: { upstreamRef: 'refs/heads/main', inFlightJobs: [], landTasks: [] },
    promotions: readyPromo, merged: [], menu: false,
  },
  'ready-round': {
    title: `Merge ${BRANCH} → main · #9`,
    landing: readyLanding([
      { ...checkSection(1, 'job-c1', '2026-09-25T05:30:00Z'), entries: checkSection(1, 'job-c1', '2026-09-25T05:30:00Z').entries.slice(0, 7) },
      handedBack,
      checkSection(2, 'job-c2', '2026-09-25T06:20:00Z'),
    ], 9),
    integration: { upstreamRef: 'refs/heads/main', inFlightJobs: [], landTasks: [] },
    promotions: readyPromo, merged: [], menu: false,
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
      marks: [...document.querySelectorAll('.landing-timeline-section')].map((section) => ({
        job: section.getAttribute('data-job'),
        lines: [...section.querySelectorAll('.landing-timeline-entry')].map((line) => {
          const mark = line.querySelector('.landing-timeline-glyph');
          return `${mark?.textContent} ${mark?.className.replace('landing-timeline-glyph ', '')} · ${line.querySelector('.landing-timeline-text')?.textContent}`;
        }),
      })),
    }));
    report.push({ theme, frame: name, ...drawn, unhandled: fixtures.unhandled });
    console.log(theme, name, JSON.stringify(drawn), fixtures.unhandled.length ? `unhandled=${fixtures.unhandled.join(' ')}` : '');
    await page.close();
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
server.close();
