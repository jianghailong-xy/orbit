// Coordinator-fold board: the real session page on vite, fed by the repo's ui-migration fixtures plus a
// coordinator conversation shaped like the Runner link v1 coordinator's real transcript (2026-10-25..11-05):
// the owner's question, then a run of turns Orbit opened (evidence, watch, background job, can-start),
// each with the coordinator's reply, then the newest one.
import { chromium } from '/var/tmp/coord-fold-mock/today/node_modules/playwright/index.mjs';
import { installFixtures, installFixedDate } from '/var/tmp/coord-fold-mock/today/src/web/ui-migration/fixtures.mjs';
import { SESSION, SESSION_PATH, WORKSPACE, RUNNER } from '/var/tmp/coord-fold-mock/today/src/web/ui-migration/session-fixtures.mjs';

export const BASES = { today: 'http://127.0.0.1:5871', new: 'http://127.0.0.1:5872' };
const ws = { ...WORKSPACE, name: 'orbit' };
const WATCH = '01a17ddf-88ed-725b-8964-f01924cc7c97';
const tid = (n) => `0195c0de-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;
const PROJECT = 'Runner link v1: runner ↔ control plane over WebSocket';

function watchText(reason, task) {
  return [
    `Orbit Watch ${WATCH} matched at generation 1: ${reason}`, '',
    'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:', '',
    '```json',
    JSON.stringify({ watchId: WATCH, generation: 1, matchedAt: '2026-09-28T10:10:00.000Z', reason,
      changedTargets: [{ kind: 'SESSION', id: task, state: 'IDLE' }], latestSnapshot: { evaluatedAt: '2026-09-28T10:10:00.000Z', targets: [] } }, null, 2),
    '```',
  ].join('\n');
}
const BG = `<background-job-wake>
  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
    bgj_05c42665fe0a｜watch｜bash watch/main-release-0237.sh｜Wait for runner 0.1.237 to reach main
      ended｜completed｜exit code 0
      output /root/.orbit/runs/x/bgj_05c42665fe0a.output｜this covers bytes 0–86
      output tail:
        main 512fd2c2a carries 0.1.237 at 2026-09-28T10:52:54Z
  The control plane recorded this for you; the user did not write it. Read the whole output with mcp__orbit__bg_output by id.
</background-job-wake>`;

function evidenceText(title, rev) {
  return `From Orbit · project “${PROJECT}” has a revision of completion evidence for you to decide\n\nTask “${title}” submitted revision ${rev} of its completion evidence.\n\nThis project has Automatic on: whether a task is done is yours to decide from its evidence. First read revision ${rev} of the evidence with task_evidence_list…`;
}
function readyText(title) {
  return `From Orbit · project “${PROJECT}” has a downstream task that can start now\n\nTask “${title}” has every dependency DONE…`;
}

/** Builds events turn by turn. */
export function coordinatorEvents() {
  let seq = 0;
  const ev = [];
  const at = (m) => new Date(Date.parse('2026-09-28T09:00:00Z') + m * 60000).toISOString();
  let turnN = 0;
  function turn(min, userPayload, steps, reply, dur = 3) {
    const T = `turn${++turnN}`;
    ev.push({ seq: ++seq, type: 'user', payload: userPayload, turnId: T, ts: at(min) });
    let s = 0;
    for (const [name, input, out] of steps) {
      const id = `t${seq}`;
      ev.push({ seq: ++seq, type: 'tool_use', payload: { id, name, input }, turnId: T, ts: at(min + (s += 0.2)) });
      ev.push({ seq: ++seq, type: 'tool_result', payload: { toolUseId: id, content: out }, turnId: T, ts: at(min + (s += 0.1)) });
    }
    ev.push({ seq: ++seq, type: 'assistant', payload: { text: reply }, turnId: T, ts: at(min + dur) });
    ev.push({ seq: ++seq, type: 'turn_end', payload: {}, turnId: T, ts: at(min + dur) });
  }
  const delivery = (min, kind, n, title, rev, text) => ({
    text, coordinatorDelivery: { kind, task: { id: tid(n), title }, revision: rev, count: null, deliveredAt: at(min), toCoordinator: true },
  });
  const read = (n) => [['mcp__orbit__task_evidence_list', { taskId: tid(n) }, '{"revisions":[…]}'], ['mcp__orbit__task_get', { taskId: tid(n) }, '{…}'],
    ['Bash', { command: 'git merge-tree --write-tree project/34bc main orbit/task-b1', description: 'Trial-merge the task branch' }, 'clean'],
    ['mcp__orbit__task_evidence_decide', { taskId: tid(n), decision: 'CONFIRM' }, '{"ok":true}']];

  turn(0, { text: 'B 组的任务都开工了吗？哪些在等我？' },
    [['mcp__orbit__task_list', { projectId: 'p' }, '[…]']],
    'B 组 7 个任务里，B1–B3 已经在跑，B4–B6 在等 B1 落地后自动开工。\n\n现在没有在等你的事。', 1);
  turn(14, delivery(14, 'EVIDENCE_SUBMITTED', 11, 'B1 Targeted hints over NATS', 2, evidenceText('B1 Targeted hints over NATS', 2)), read(11),
    '我确认了 B1（[定向提示与 NATS](orbit-task:x)），它正在落地，落地后 B4 会自动开工。\n\n**确认依据**\n- 第 1 版被退回的原因是合并冲突，这次已经解决，两边的改动都保留了。\n- B1 和当前项目分支、和 main 都已经试合并过，没有冲突。\n- 测试结果：单测 5501/5501，数据库相关测试全部通过。', 6);
  turn(31, { text: watchText('SESSION_IDLE 1/1', tid(11)) }, [['mcp__orbit__session_get', { sessionId: 's' }, '{…}']],
    '这是之前设的提醒：B1 的会话 09:28 已经停下，我已经判了它通过，这里不用再做什么。', 1);
  turn(44, delivery(44, 'DEPENDENT_READY', 14, 'B4 Link gateway v1', null, readyText('B4 Link gateway v1')),
    [['mcp__orbit__task_get', { taskId: tid(14) }, '{…}'], ['mcp__orbit__task_start', { taskId: tid(14) }, '{…}']],
    'B4（[链路网关 v1](orbit-task:x)）已经开工，等它交证据我再判。', 2);
  turn(58, { text: BG, controlPlaneNote: BG }, [['mcp__orbit__bg_output', { id: 'bgj_05c42665fe0a' }, 'main 512fd2c2a carries 0.1.237']],
    'runner 0.1.237 已经进了 main（512fd2c2a），A6 的部署前提齐了，等你答复第四张卡片后再发布。', 1);
  turn(72, delivery(72, 'EVIDENCE_SUBMITTED', 15, 'B4b Approval hints on the link', 1, evidenceText('B4b Approval hints on the link', 1)), read(15),
    '我把 [B4b 审批结果提示](orbit-task:x) 的第 1 版退回了。功能本身没问题，退回只是因为落地时会和 B5 冲突。\n\n**要求 B4b 做的**：先合并最新的项目分支，保留 B5 的新结构，把审批提示挪到“本副本发起的单条事件”这条路径上。', 5);
  turn(90, { text: watchText('SESSION_IDLE 1/1', tid(14)) }, [['mcp__orbit__session_get', { sessionId: 's' }, '{…}']],
    '这是 10-25 设的一个提醒，看一个任务会不会失败。它已经到期了，那个任务早就完成了，不用续，也不用做别的。', 1);
  turn(104, delivery(104, 'EVIDENCE_SUBMITTED', 16, 'B5 Event intake rework', 1, evidenceText('B5 Event intake rework', 1)), read(16),
    '我核实了 B5（[事件入库改造](orbit-task:x)）的证据并确认了它，B5 接下来会落地。\n\n**依据**\n- **合并**：B5 建在 B4 落地后的项目分支上，和项目分支、和 main 都能干净合并。\n- **测试**：链路事件的 8 种情况都覆盖了，全部通过。', 5);
  turn(118, { text: '为什么 B4b 被退回了？' }, [],
    'B4b 的功能是对的，但它是在 B5 落地之前从旧的项目分支写下去的。B5 改写了 `realtime.service.ts` 里的发布逻辑，B4b 的提示正好加在被改写的旧代码里，按现在的样子落地一定会冲突。我已经让它先合并最新的项目分支再交第 2 版。', 1);
  turn(141, delivery(141, 'EVIDENCE_SUBMITTED', 15, 'B4b Approval hints on the link', 2, evidenceText('B4b Approval hints on the link', 2)), read(15),
    '我确认了 B4b（[链路上的审批结果提示](orbit-task:x)）的第 2 版，它会和 B6 一起排队落地。\n\n**这一版的核实结果**\n- 上一版退回的原因是和 B5 冲突，这次已经处理：B4b 合并了包含 B5 的项目分支。\n- 和项目分支、main、即将落地的 B6 试合并，都没有冲突。\n\n**进度**\n- 已完成：A1–A5、B1–B5、B4b。\n- 进行中：B6。', 5);
  return ev;
}

const sessionRow = (over) => ({
  ...SESSION, workspace: ws, workspaceId: ws.id, pendingApprovals: 0, engineTurnActive: false,
  status: 'IDLE', runState: 'IDLE', lifecycleState: 'OPEN', pinnedAt: null, provider: 'claude',
  tags: [], folderId: null, shared: false, lastUserText: null, lastAssistantText: null,
  title: 'Coordinator · Runner link v1', lastTurnAt: '2026-09-28T11:46:00Z', updatedAt: '2026-09-28T11:46:00Z', ...over,
});

export async function launch() {
  return chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/coord-fold-mock/fonts.conf' } });
}

export async function open(browser, { tree, events, mode = 'group', treeShut = false, theme = 'light', size = 'desktop', width, height }) {
  const phone = size === 'phone';
  const context = await browser.newContext({
    viewport: phone ? { width: width ?? 390, height: height ?? 2400 } : { width: width ?? 1280, height: height ?? 3200 },
    deviceScaleFactor: phone ? 3 : 2, isMobile: phone, hasTouch: phone, colorScheme: theme, locale: 'en-US',
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(240_000);
  page.setDefaultTimeout(120_000);
  await page.addInitScript(([m, deps, shut]) => { window.__mockDeps = deps; window.__mockTreeShut = shut; Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); window.__mockFold = m; }, [mode, { [tid(14)]: tid(11), [tid(15)]: tid(14), [tid(16)]: tid(14) }, treeShut]);
  await installFixedDate(page);
  await installFixtures(page, { theme });
  const row = sessionRow({});
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return route.fallback();
    if (path === `/api${SESSION_PATH}/events/page`) return route.fulfill({ status: 200, json: { events, hasMore: false } });
    if (path === `/api${SESSION_PATH}`) return route.fulfill({ status: 200, json: row });
    if (path === '/api/sessions') return route.fulfill({ status: 200, json: [row] });
    if (path === '/api/runners') return route.fulfill({ status: 200, json: [{ ...RUNNER, name: 'HPC' }] });
    if (path === '/api/workspaces') return route.fulfill({ status: 200, json: [ws] });
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASES[tree] + SESSION_PATH);
  await page.locator('.chat-user-wrap').last().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  return { context, page, errors };
}

export const settle = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
