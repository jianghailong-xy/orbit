// Fold-rule options board: the real session page (prototype tree with a runtime rule switch) on vite,
// fed by the repo's ui-migration fixtures plus an ordinary conversation shaped like the owner's
// 2026-11-12 screenshot (sample text): a question, five background-job turns, the last one the answer.
import { chromium } from '/var/tmp/coord-fold-mock/today/node_modules/playwright/index.mjs';
import { installFixtures, installFixedDate } from '/var/tmp/fold-rule-mock/proto/src/web/ui-migration/fixtures.mjs';
import { SESSION, SESSION_PATH, WORKSPACE, RUNNER } from '/var/tmp/fold-rule-mock/proto/src/web/ui-migration/session-fixtures.mjs';
export { coordinatorEvents } from '/var/tmp/coord-fold-mock/lib.mjs';

const BASE = 'http://127.0.0.1:5881';
const ws = { ...WORKSPACE, name: 'data-pipeline' };

const wake = (id, name, tail) => `<background-job-wake>
  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
    ${id}｜query｜bash q.sh｜${name}
      ended｜completed｜exit code 0
      output /root/.orbit/runs/x/${id}.output｜this covers bytes 0–120
      output tail:
        ${tail}
  The control plane recorded this for you; the user did not write it. Read the whole output with mcp__orbit__bg_output by id.
</background-job-wake>`;

const REPORT = `查完了。结论分三层。

### 1. 自动更新任务确认存在且健康
\`daily_ready_check\`（每 10 分钟一次），最近 41,868 次成功，**47 次失败全部停在 10-23 之前**，当前没有在跑或失败的实例。
所以不是任务挂了——它每 10 分钟都在算，算完判定「未达标」，才没有推进就绪日。

### 2. 但台账侧 11-10 是齐的
| 车道 | 行数 | 小时 |
|---|---|---|
| p0 | 13,984 | 24/24 |
| p1 | 4,224 | 24/24 |
| p2 | 4,224 | 24/24 |
| p3 | 4,224 | 24/24 |

最后一行落在 **11-11 20:xx UTC**，仍在任务「只算 D-1」的窗口内。所以也不是"数据晚到、窗口关了"。

### 3. 我卡在哪
- ✅ 确定：任务在跑、成功、判定未达标；台账与时间窗都排除了。
- ⚠️ 最可疑：任务带着 \`--patch_ready_priority 7\`，但台账里**只有 priority 0/1/2/3，没有 7**。如果脚本要先等到 patch 车道，它就永远等不到。

要不要我把 \`report.data_date\` 也推到 \`20261110\`？`;

export function plainEvents() {
  let seq = 0;
  const ev = [];
  const at = (m) => new Date(Date.parse('2026-11-12T01:40:00Z') + m * 60000).toISOString();
  let n = 0;
  function turn(min, payload, steps, reply, dur = 1) {
    const T = `turn${++n}`;
    ev.push({ seq: ++seq, type: 'user', payload, turnId: T, ts: at(min) });
    let s = 0;
    for (const [name, input, out] of steps) {
      const id = `t${seq}`;
      ev.push({ seq: ++seq, type: 'tool_use', payload: { id, name, input }, turnId: T, ts: at(min + (s += 0.1)) });
      ev.push({ seq: ++seq, type: 'tool_result', payload: { toolUseId: id, content: out }, turnId: T, ts: at(min + (s += 0.1)) });
    }
    if (reply) ev.push({ seq: ++seq, type: 'assistant', payload: { text: reply }, turnId: T, ts: at(min + dur) });
    ev.push({ seq: ++seq, type: 'turn_end', payload: {}, turnId: T, ts: at(min + dur) });
  }
  const bg = (min, id, name, tail, steps, reply) => {
    const w = wake(id, name, tail);
    turn(min, { text: w, controlPlaneNote: w }, [['mcp__orbit__bg_output', { id }, tail], ...steps], reply);
  };
  const sql = (d) => ['Bash', { command: 'clickhouse-client -q "…"', description: d }, '…'];
  turn(0, { text: '日报表 11-10 为什么还没就绪？查一下就绪任务卡在哪，重点看 priority=7 的 patch 车道齐不齐。' },
    [sql('List the ready job and its recent runs'), ['mcp__orbit__bg_run', { name: 'Ledger split by priority' }, '{"id":"bgj_a1"}']],
    '我起了一个后台查询，按 priority 拆 11-10 的台账，结果回来我接着看。');
  bg(8, 'bgj_a1', 'Ledger split by priority', 'p0 13984 · p1 4224 · p2 4224 · p3 4224', [['mcp__orbit__bg_run', { name: 'Priority lanes' }, '{"id":"bgj_a2"}']],
    '等这版结果。同时我在想另一个更可能的解释：这个任务只算 D-1——如果 11-10 的数据是在 11-11 23:59 UTC 之后才齐的，它就永远不会回头看 11-10。下一步我会用 MAX(updated_at) 验证这个时间窗。');
  bg(11, 'bgj_a2', 'Priority lanes with mask-safe decomposition', '4 lanes, no priority 7', [['mcp__orbit__bg_run', { name: 'Last row per day' }, '{"id":"bgj_a3"}']],
    '等最后一个读数（每业务日最后一行台账落到哪天几点）。这能直接判定：11-10 是不是在「只算 D-1」的窗口关掉之后才齐的。');
  bg(13, 'bgj_a3', "When did each day's last ledger row land", '11-10 → 11-11 20:4x UTC', [['mcp__orbit__bg_run', { name: 'Shard coverage' }, '{"id":"bgj_a4"}']],
    '最后一步：直接跑任务同款判据（176 分片 × 每小时）。这个查询要扫 11-10 全天的量，可能要几分钟。');
  bg(17, 'bgj_a4', 'Shard coverage per hour on 2026-11-10', '24/24 hours ≥ 0.95', [['mcp__orbit__bg_run', { name: 'Read the ready script' }, '{"id":"bgj_a5"}']],
    '最后一次尝试读脚本。回来后给你完整结论（已确认的部分：任务是活的、每 10 分钟成功一次、判定"未达标"才不推进）。');
  bg(20, 'bgj_a5', 'Try to read the ready script from the job container', 'No such file', [sql('Read the three ready-date stores')], REPORT);
  const w6 = wake('bgj_a6', 'Clean up the scratch tables', 'dropped 3 tables');
  turn(29, { text: w6, controlPlaneNote: w6 }, [['mcp__orbit__bg_output', { id: 'bgj_a6' }, 'dropped 3 tables']], null);
  return ev;
}

const sessionRow = (over) => ({
  ...SESSION, workspace: ws, workspaceId: ws.id, pendingApprovals: 0, engineTurnActive: false,
  status: 'IDLE', runState: 'IDLE', lifecycleState: 'OPEN', pinnedAt: null, provider: 'claude',
  tags: [], folderId: null, shared: false, lastUserText: null, lastAssistantText: null,
  title: 'Why is 11-10 not ready', lastTurnAt: '2026-11-12T02:10:00Z', updatedAt: '2026-11-12T02:10:00Z', ...over,
});

export async function launch() {
  return chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome',
    env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/fold-rule-mock/fonts.conf' } });
}

export async function open(browser, { events, rules = [], coordinator = false, title, width = 1280, height = 3200 }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US',
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(240_000);
  page.setDefaultTimeout(120_000);
  await page.addInitScript(([r, c]) => { window.__foldRules = r; window.__mockCoordinator = c; Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); }, [rules, coordinator]);
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  const row = sessionRow(title ? { title } : {});
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
  await page.goto(BASE + SESSION_PATH);
  await page.locator('.chat-user-wrap').last().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  return { context, page, errors };
}

export const settle = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
