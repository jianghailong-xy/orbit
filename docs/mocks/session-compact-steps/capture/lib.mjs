// Shared bits for the steer-foot board: the real session page (WorkspaceView + Transcript) on a vite
// dev server, fed by the repo's own ui-migration fixtures plus a conversation shaped like the owner's
// screenshot — a Claude turn still at work, and a message sent into it ("这个也没答复，再检查下同类问题").
import { chromium } from '/var/tmp/compact-steps-mock/today/node_modules/playwright/index.mjs';
import { installFixtures, installFixedDate } from '/var/tmp/compact-steps-mock/today/src/web/ui-migration/fixtures.mjs';
import { SESSION, SESSION_PATH, WORKSPACE, RUNNER } from '/var/tmp/compact-steps-mock/today/src/web/ui-migration/session-fixtures.mjs';

export const BASES = { today: process.env.BASE_TODAY ?? 'http://127.0.0.1:5861', new: process.env.BASE_NEW ?? 'http://127.0.0.1:5862' };
export { SESSION_PATH };

export const STEER_TEXT = '这个也没答复，再检查下同类问题';

const ws = { ...WORKSPACE, name: 'orbit-prod' };
// Fixtures freeze the clock at 2026-09-28T12:00Z = 20:00 in Shanghai; the steer went in 2 minutes before.
const t = (m, s = 0) => `2026-09-28T11:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;

/** The running turn, and the steer at `delivery`. */
export function runningEvents({ delivery = 'acknowledged', withdrawable = false } = {}) {
  const R = 'turnR', S = 'turnS';
  const ev = [
    { seq: 1, type: 'user', payload: { text: '飞书群里有几条消息机器人没答复，查一下原因' }, turnId: R, ts: t(50) },
    { seq: 2, type: 'assistant', payload: { text: '先看机器人最近收到的事件和回复记录。' }, turnId: R, ts: t(50, 20) },
    { seq: 3, type: 'tool_use', payload: { id: 'b1', name: 'Bash', input: { command: 'grep -c "reply skipped" logs/bot-2026-09-28.log', description: 'Count skipped replies' } }, turnId: R, ts: t(50, 30) },
    { seq: 4, type: 'tool_result', payload: { toolUseId: 'b1', content: '7' }, turnId: R, ts: t(50, 32) },
    { seq: 5, type: 'assistant', payload: { text: '今天有 7 条消息被跳过了，原因都是 `trace_id` 查询失败。接着看是哪一步报的错。' }, turnId: R, ts: t(51) },
    { seq: 6, type: 'tool_use', payload: { id: 'b2', name: 'Bash', input: { command: 'grep -n "trace_id" -A3 logs/bot-2026-09-28.log | head -40', description: 'Show the trace_id failures' } }, turnId: R, ts: t(57, 30) },
    { seq: 7, type: 'user', payload: { text: STEER_TEXT, delivery: 'enqueued', steer: true, ...(withdrawable ? { withdrawable: true } : {}) }, turnId: S, ts: t(58) },
  ];
  // The runner's own order: written, then (if the engine read it) acknowledged — each its own seq.
  const stages = delivery === 'acknowledged' ? ['written', 'acknowledged'] : [delivery];
  stages.forEach((d, i) => ev.push({ seq: 8 + i, type: 'user_delivery', payload: { turnId: S, delivery: d }, turnId: S, ts: t(58, 1 + i) }));
  return ev;
}

const sessionRow = (over) => ({
  ...SESSION, workspace: ws, workspaceId: ws.id, pendingApprovals: 0, engineTurnActive: true,
  status: 'RUNNING', runState: 'RUNNING', lifecycleState: 'OPEN', pinnedAt: null, provider: 'claude',
  tags: [], folderId: null, shared: false, lastUserText: null, lastAssistantText: null,
  title: '服务打不开了', lastTurnAt: t(58), updatedAt: t(58), ...over,
});

export async function launch() {
  return chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/compact-steps-mock/fonts.conf' } });
}

/** A page of tree `tree` ('today' | 'new') on the real session route with `events` as its conversation. */
export async function open(browser, { tree, events, live, theme = 'light', size = 'desktop', width, height }) {
  const phone = size === 'phone';
  const context = await browser.newContext({
    viewport: phone ? { width: width ?? 390, height: height ?? 760 } : { width: width ?? 1280, height: height ?? 800 },
    deviceScaleFactor: phone ? 3 : 2,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(240_000);
  page.setDefaultTimeout(120_000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  await installFixtures(page, { theme });
  const row = sessionRow(live === false ? { engineTurnActive: false, status: 'IDLE', runState: 'IDLE' } : {});
  // Registered after the fixtures, so these answer first; anything else falls through to them.
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

/** The owner's screenshot as a conversation: six settled steps, a seventh call in flight when `live`. */
export function outageEvents({ live = true, failed = false } = {}) {
  const R = 'turnR';
  let seq = 0, sec = 0;
  const ts = () => { sec += 7; const d = new Date(Date.parse('2026-09-28T11:30:00Z') + sec * 1000); return d.toISOString(); };
  const ev = [];
  const push = (type, payload) => ev.push({ seq: ++seq, type, payload, turnId: R, ts: ts() });
  let n = 0;
  const think = (s, text = '先确认容器和端口状态，再决定从哪一层查。') => push('thinking', { text, thinkingMs: s * 1000 });
  const bash = (command, description, out = 'ok', isError = false) => {
    const id = `b${++n}`;
    push('tool_use', { id, name: 'Bash', input: { command, description } });
    push('tool_result', { toolUseId: id, content: out, ...(isError ? { isError: true } : {}) });
  };
  const say = (text) => push('assistant', { text });
  push('user', { text: '服务打不开了' });
  think(15); bash('ls /root/orbit/deploy', 'List deploy files', 'docker-compose.yml\n.env'); bash('docker compose ps', 'Show container status', 'apiserver   Up 31 minutes\npostgres    Up 3 days\nweb         Up 31 minutes');
  say('容器都活着。先测实际访问：');
  think(25); bash('curl -sI https://orbit.example.com | head -1', 'Probe the site', 'HTTP/2 200'); bash('curl -s -o /dev/null -w "%{http_code}" https://orbit.example.com/api/health', 'Probe the API health', '200');
  bash('docker logs --since 10m orbit-web 2>&1 | tail -5', 'Tail web logs', '...'); bash('docker logs --since 10m orbit-gateway 2>&1 | tail -5', 'Tail gateway logs', '...');
  say('站点本身已恢复 200。看看现在 API 通不通：');
  think(8); bash('curl -s https://orbit.example.com/api/sessions -H "Authorization: Bearer $T" | head -c 300', 'Call the sessions API', '{"statusCode":500}');
  bash('docker logs --since 5m orbit-apiserver 2>&1 | grep -m3 Error', 'Grep apiserver errors', 'PrismaClientKnownRequestError: Unable to start a transaction in the given time');
  say('找到病灶了：apiserver 能起，但 Prisma 事务池被吃干——`Unable to start a transaction in the given time`，现在还在持续。查 postgres 侧：');
  think(52); bash('psql -c "select count(*) from pg_stat_activity"', 'Count connections', '26'); bash('psql -c "select * from pg_locks where not granted"', 'Look for lock waits', '(0 rows)');
  bash('psql -c "show max_connections"', 'Show connection limit', '100', failed);
  say('DB 侧完全健康（26/100 连接、无锁等待）。查 apiserver 容器自身状态和错误起点：');
  think(55); bash('psql -c "select pid, state, xact_start, query from pg_stat_activity where state like \'idle in%\'"', 'Find idle transactions', '4121 | idle in transaction | 09:32:19 | BEGIN');
  bash('docker inspect -f "{{.State.StartedAt}}" orbit-apiserver', 'Show container start time', '2026-09-28T09:32:11Z');
  say('一条从 09:32:19（容器刚起）就卡住的 `idle in transaction`——BEGIN 后 29 分钟没动。再看容器内谁在烧 CPU、错误频率：');
  think(42); bash('ls /proc/1/task', 'List apiserver threads', '1 7 8 9 10 11'); bash('top -b -n1 -H -p 1 | head -12', 'Show per-thread CPU', '...');
  bash('cat /proc/1/task/1/stat', 'Read main thread stat', '...'); bash('docker logs --since 1m orbit-apiserver 2>&1 | grep -c Error', 'Count errors per minute', '184'); bash('cat /proc/loadavg', 'Show load', '0.52 0.49 0.47');
  say('主线程自启动起一直在烧 ~50% 单核——有忙循环。看看这次 0.1.247 发布改了什么：');
  think(29); bash('git log --oneline v0.1.246..v0.1.247 | head', 'List release commits', '...'); bash('git diff --stat v0.1.246..v0.1.247 | tail -3', 'Show release diff size', '...');
  bash('git show --stat HEAD~2', 'Show abandoned-checkout commit', '...'); bash('docker images orbit-apiserver --format "{{.Tag}}"', 'List apiserver images', '0.1.247\n0.1.246');
  say('主线程在空转烧 CPU（3 秒 184 ticks）。这次发布里最可疑的是 "abandoned-checkout inventory"。先看有没有可回滚的旧镜像，同时找源码里的嫌疑：');
  think(18);
  const id = `b${++n}`;
  push('tool_use', { id, name: 'Bash', input: { command: "grep -rn 'url\\s*=\\|connection_limit\\|pool_timeout' /root/orbit/src/apiserver/prisma/schema.prisma 2>/dev/null | head; ls /root/orbit/src/apiserver/prisma/ 2>/dev/null", description: 'Show prisma datasource config' } });
  if (!live) { push('tool_result', { toolUseId: id, content: 'url = env("DATABASE_URL")' }); say('datasource 没设 `connection_limit`，默认池是 `num_cpus * 2 + 1`。'); push('turn_end', {}); }
  return ev;
}
