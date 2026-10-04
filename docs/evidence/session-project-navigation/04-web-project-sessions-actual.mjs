// Capture production App / WorkspaceView with isolated REST fixtures; no UI is replaced.
// Reproduce: node docs/evidence/session-project-navigation/04-web-project-sessions-actual.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { uuidToBase62 } from '@orbit/shared';
import { installFixedDate, installFixtures } from '../../../src/web/ui-migration/fixtures.mjs';
import { SESSION, WORKSPACE, RUNNER } from '../../../src/web/ui-migration/session-fixtures.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const dir = fileURLToPath(new URL('./', import.meta.url));
const origin = process.env.ORBIT_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5189';
const server = process.env.ORBIT_PREVIEW_ORIGIN ? null : spawn(process.execPath,
  [resolve(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5189', '--strictPort'],
  { cwd: resolve(repo, 'src/web'), stdio: 'ignore' });
const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const projectId = id(901);
const workspace = { ...WORKSPACE, name: 'orbit' };
const projectTitle = '后台作业生命周期';
const membership = (role) => ({ projectId, projectTitle, projectStatus: 'OPEN', role });
const member = (n, title, role, extra = {}) => ({
  ...SESSION, id: id(n), title, workspace, projectMembership: membership(role),
  lastTurnAt: '2026-09-28T11:00:00Z', createdAt: '2026-09-26T10:00:00Z', ...extra,
});
const coordinator = member(910, projectTitle, 'COORDINATOR', {
  projectId, projectTitle, pinnedAt: '2026-09-27T10:00:00Z', pendingApprovals: 1,
  waitingKind: 'OWNER_ITEM', ownerItems: [{ kind: 'PROMOTION_APPROVAL', since: '2026-09-28T10:00:00Z' }],
});
const members = [
  coordinator,
  member(911, 'runner 回收孤儿进程', 'TASK', { status: 'RUNNING', runState: 'RUNNING', lastToolUse: 'Bash', lastTurnAt: '2026-09-28T11:59:00Z' }),
  member(912, 'engine 退出时保留后台作业', 'TASK', { status: 'RUNNING', runState: 'RUNNING', lastToolUse: 'Edit', lastTurnAt: '2026-09-28T11:54:00Z' }),
  member(913, 'bg_output 分页', 'TASK', { status: 'FAILED', runState: 'FAILED', lastAssistantText: '测试失败：输出截断少了最后一行。', lastTurnAt: '2026-09-28T11:12:00Z' }),
  member(914, '后台作业列表 UI', 'CONTEXT', { lastAssistantText: '已提交，等 coordinator 验收。', lastTurnAt: '2026-09-27T11:00:00Z' }),
  member(915, '判断：后台作业生命周期', 'JUDGMENT', { lastAssistantText: '判断完成。', lastTurnAt: '2026-09-26T11:00:00Z' }),
];
const loose = { ...SESSION, id: id(920), title: '分享链接的过期时间', workspace, lastAssistantText: '默认 7 天，可以改成永不过期。' };
const sidebar = {
  id: projectId, title: projectTitle, status: 'OPEN', createdAt: '2026-09-26T10:00:00Z',
  lastActivityAt: '2026-09-28T11:59:00Z', buckets: { running: 2 }, taskCounts: { done: 27, failed: 1, total: 34 },
  attention: { ownerItems: [], startRequest: null, coordinatorItems: null },
  coordinatorActivity: { working: false, lastTurnAt: coordinator.lastTurnAt },
};
let browser;
const errors = [];
const requests = [];
try {
  await Promise.race([
    (async () => { for (;;) { try { if ((await fetch(origin)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Vite did not become ready')), 15000)),
  ]);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' });
  page.on('pageerror', (error) => errors.push(error.message));
  await installFixedDate(page);
  const fixtures = await installFixtures(page, { theme: 'light' });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() !== 'GET') return route.fallback();
    if (path === '/api/workspaces') return route.fulfill({ json: [workspace] });
    if (path === '/api/projects/sidebar') return route.fulfill({ json: [sidebar] });
    if (path === `/api/projects/${projectId}`) return route.fulfill({ json: { ...sidebar, goal: '', _count: { tasks: 34 }, startedAt: '2026-09-26T10:00:00Z', acceptanceCriteriaItems: [] } });
    if (path.startsWith(`/api/projects/${projectId}/`)) {
      const suffix = path.slice(`/api/projects/${projectId}`.length);
      const projectReads = {
        '/acceptance/criteria-decisions/pending': { projectId, readAt: '2026-09-28T12:00:00Z', count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] },
        '/promotions/current': null, '/promotions/merged': [],
        '/open-items': { needsYou: [], withCoordinator: [], startRequest: null },
        '/acceptance/confirmation': null,
      };
      if (Object.hasOwn(projectReads, suffix)) return route.fulfill({ json: projectReads[suffix] });
    }
    if (path === '/api/sessions/counts') return route.fulfill({ json: [{ workspaceId: WORKSPACE.id, active: 2, running: 2, jobs: 0, needsYou: 1 }] });
    if (path === '/api/sessions') {
      requests.push(url.search);
      const rows = url.searchParams.get('view') === 'completed' ? [] : url.searchParams.has('projectId') ? members : [loose, ...members];
      return route.fulfill({ json: rows });
    }
    const session = [loose, ...members].find((row) => path.startsWith(`/api/sessions/${row.id}`));
    if (session) {
      const suffix = path.slice(`/api/sessions/${session.id}`.length);
      if (!suffix) return route.fulfill({ json: session });
      if (suffix === '/events/page') return route.fulfill({ json: { events: [], hasMore: false } });
      if (suffix === '/created-tasks') return route.fulfill({ json: { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] } });
      if (suffix === '/diff') return route.fulfill({ json: { files: [], patches: [] } });
      if (['/turns', '/approvals', '/background'].includes(suffix)) return route.fulfill({ json: [] });
    }
    return route.fallback();
  });
  await page.goto(`${origin}/sessions/${coordinator.id}`);
  const row = page.locator('.session-project-row');
  await row.waitFor();
  const chip = row.locator('.session-project-progress');
  assert.equal(await chip.getAttribute('title'), '6 sessions · 2 running');
  await chip.hover();
  const hoverBorder = await chip.evaluate((el) => getComputedStyle(el).borderColor);
  await page.screenshot({ path: `${dir}/04-web-project-sessions-list.png`, animations: 'disabled' });
  await row.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'Open Coordinator' }).waitFor();
  await page.getByRole('menu').evaluate(async (menu) => {
    const popup = menu.closest('.ant-dropdown') ?? menu;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(popup.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
  });
  const rowMenu = await page.getByRole('menu').innerText();
  assert(rowMenu.includes('Open Coordinator') && rowMenu.includes('Sessions') && rowMenu.includes('Open Project') && rowMenu.includes('Unpin') && rowMenu.includes('Move'));
  assert(!/Complete|Share|Delete/.test(rowMenu));
  await page.screenshot({ path: `${dir}/04-web-project-sessions-menu.png`, animations: 'disabled' });
  await page.getByRole('menuitem', { name: 'Sessions', exact: true }).click();
  await page.locator('.session-project-page-header').waitFor();
  await page.getByText('Project · 6 sessions', { exact: true }).waitFor();
  assert(new URL(page.url()).searchParams.get('project') === projectId);
  assert.deepEqual(await page.locator('.session-col .session-row .session-title').allTextContents(), [projectTitle, ...members.slice(1).map((row) => row.title)]);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${dir}/04-web-project-sessions-page.png`, animations: 'disabled' });
  await page.locator('.session-project-page-header').getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'Open Project', exact: true }).waitFor();
  await page.getByRole('menu').evaluate(async (menu) => {
    const popup = menu.closest('.ant-dropdown') ?? menu;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(popup.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
  });
  const pageMenu = await page.getByRole('menu').innerText();
  assert.equal(pageMenu.trim(), 'Open Project\nOpen Coordinator');
  await page.screenshot({ path: `${dir}/04-web-project-sessions-page-menu.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByText('Project · 6 sessions', { exact: true }).waitFor();
  assert(new URL(page.url()).searchParams.get('project') === projectId);
  assert.equal(await page.locator('.session-col .session-new').count(), 0);
  const groupHeadingPadding = await page.locator('.session-col-list > section > .session-section-head').evaluateAll((headings) => headings.map((heading) => ({ title: heading.textContent.trim(), paddingTop: getComputedStyle(heading).paddingTop })));
  assert(groupHeadingPadding.length >= 4);
  assert(groupHeadingPadding.slice(1).every((heading) => heading.paddingTop === '12px'));
  const desktopColumn = await page.locator('.session-col').boundingBox();
  await page.screenshot({ path: `${dir}/04-web-project-sessions-page-column.png`, animations: 'disabled', clip: desktopColumn });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/workspaces/${WORKSPACE.id}?project=${projectId}`);
  await page.getByText('Project · 6 sessions', { exact: true }).waitFor();
  await page.screenshot({ path: `${dir}/04-web-project-sessions-phone.png`, animations: 'disabled' });
  assert.deepEqual(errors, []);
  fixtures.assertHandled();
  const board = `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:32px;background:#e9e9ee;font:15px system-ui;color:#16161a}h1{font-size:25px;margin:0 0 8px}p{margin:0 0 22px;color:#4a4a52}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{min-width:0}h2{font-size:15px;margin:0 0 10px}img{width:100%;display:block;border-radius:12px;border:1px solid #ddd}.wide{grid-column:1/-1}.columns{display:flex;gap:24px;align-items:flex-start}.columns img{width:auto;max-width:100%;height:690px}</style><h1>Web：项目点击与项目会话页 · 实现核对</h1><p>真实 App / WorkspaceView / 样式，只有 REST/SSE 数据使用隔离桩。点击 Sessions 打开项目会话页；刷新后保留 project 参数。页头无 New session，Coordinator 在成员时间分组前。</p><div class="grid"><section class="wide"><h2>项目条目 ⋯：Open Coordinator / Sessions / Open Project，分隔线，Unpin / Move…</h2><img src="04-web-project-sessions-menu.png"></section><section class="wide"><h2>项目会话页：页头、进度、Coordinator、全部成员及手机布局</h2><div class="columns"><img src="04-web-project-sessions-page-column.png"><img src="04-web-project-sessions-phone.png"></div></section><section class="wide"><h2>项目会话页 ⋯：Open Project / Open Coordinator</h2><img src="04-web-project-sessions-page-menu.png"></section></div>`;
  await writeFile(`${dir}/04-web-project-sessions-actual.html`, board);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(new URL('./04-web-project-sessions-actual.html', import.meta.url).href);
  await page.evaluate(async () => { await Promise.all([...document.images].map((i) => i.decode())); await document.fonts.ready; });
  await page.screenshot({ path: `${dir}/04-web-project-sessions-actual.png`, fullPage: true });
  await writeFile(`${dir}/04-web-project-sessions-actual.json`, JSON.stringify({ command: 'node docs/evidence/session-project-navigation/04-web-project-sessions-actual.mjs', succeeded: true, exitCode: 0, nodeVersion: process.version, gitBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), runRecordedAt: new Date().toISOString(), browser: browser.version(), rowMenu, pageMenu, hoverBorder, groupHeadingPadding, sessionRequests: requests, errors, unhandled: fixtures.unhandled }, null, 2) + '\n');
  console.log(JSON.stringify({ rowMenu, pageMenu, hoverBorder, groupHeadingPadding, sessionRequests: requests, errors, captures: ['04-web-project-sessions-actual.png', '04-web-project-sessions-phone.png'] }));
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
