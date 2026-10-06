// Fake control plane for driving the REAL web console through a DeepSeek Harness session (P5 evidence
// only). Same state machine as the native probe's stub.py: the session advances only when the page
// sends the real request — create (POST /sessions), approve (POST …/approvals/:id/decision), stop
// (POST …/interrupt), continue (POST …/turns…). Events are the shapes the runner's dshEventMapper emits;
// nothing here is a real runner or model. Every request is logged to api.log.
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { uuidToBase62 } from '/root/.orbit/worktrees/b3f256ba-39da-5ffe-8364-77c2cef31f4f/src/shared/src/codec.ts';

const PORT = Number(process.env.PORT ?? 3995);
let n = 0;
const uid = () => uuidToBase62(`0195c0de-0000-7000-8000-${String(++n).padStart(12, '0')}`);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const log = (line: string) => appendFileSync('/var/tmp/p5-web/api.log', `${new Date().toISOString().slice(11, 19)} ${line}\n`);

const USER = uid();
const PRO = '["deepseek", "deepseek-v4-pro"]';
const FLASH = '["deepseek", "deepseek-v4-flash"]';
const DSH_CATALOG = [
  { value: PRO, label: 'DeepSeek V4 Pro', reasoningLevels: ['off', 'low', 'high', 'max'], defaultReasoningLevel: 'max' },
  { value: FLASH, label: 'DeepSeek V4 Flash', reasoningLevels: ['off', 'high'] },
];
const dshHealth = (installed = true, installationError?: string) => ({
  engine: 'dsh', installed, auth: 'unknown', ...(installed ? { version: '0.2.0-rc.2' } : {}),
  ...(installationError ? { installationError } : {}),
  dsh: { versionCompatible: true, credentialPresent: false, modelCatalogReadable: installed, requestValidation: 'unknown', sandboxEnforcement: 'unknown' },
});
const R1 = uid(), R2 = uid(), R3 = uid();
const runner = (id: string, name: string, caps: string[], engines: unknown[], install: unknown = null) => ({
  id, name, displayName: name, online: true, status: 'ONLINE', maxConcurrent: 4, activeSessions: 0,
  version: caps.length ? '0.1.212' : '0.1.198', capabilities: caps, lastHeartbeatAt: ago(0), hostname: name,
  engines: [{ engine: 'claude', installed: true, version: '2.1.290', auth: 'yes' }, ...engines],
  modelCatalog: { claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 1_000_000 }], ...(caps.length ? { dsh: DSH_CATALOG } : {}) },
  runtimeDefaultModels: { claude: 'claude-opus-5-5' }, install,
  antigravity: { supported: true, installed: false, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'available' },
});
const RUNNERS = [
  runner(R1, 'hpc', ['provider:dsh', 'provider:antigravity'], [dshHealth()]),
  runner(R2, 'old-mac', [], []),
  runner(R3, 'build-box', ['provider:dsh'], [dshHealth(false)]),
];
const W: Record<string, string> = {};
const ws = (name: string, runnerId: string, pos: number) => {
  const id = uid();
  W[name] = id;
  return { id, name, runnerId, createdAt: ago(60 * 24 * 40), provider: 'deepseek-harness', lastProvider: 'deepseek-harness', position: pos, enabled: true, workDir: `/srv/${name}` };
};
const WORKSPACES = [ws('orbit', R1, 0), ws('legacy', R2, 1), ws('builds', R3, 2)];
const P_DSH = uid(), P_DS = uid();
const HARNESS = { id: P_DSH, slug: 'deepseek-harness', label: 'DeepSeek Harness', runtime: 'dsh', models: [], defaultModel: null, presetSlug: 'deepseek-harness', modelsFromRuntime: true, followsPreset: true, enabled: true, baseUrl: 'https://api.deepseek.com/anthropic', hasApiKey: true };
const DEEPSEEK = { id: P_DS, slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000 }], defaultModel: 'deepseek-v4-pro', presetSlug: 'deepseek', followsPreset: true, enabled: true, baseUrl: 'https://api.deepseek.com/anthropic', hasApiKey: true };

const state = { stage: null as null | 'approval' | 'allowed' | 'stopped' | 'resumed', keys: 'harness', prompt: '列出仓库根目录，并加一个 NOTES.md 记下你看到了什么', followup: '继续：把 NOTES.md 再补一行测试命令', mode: 'default', effort: 'high' };
const reset = () => Object.assign(state, { stage: null, keys: 'harness', prompt: '列出仓库根目录，并加一个 NOTES.md 记下你看到了什么', followup: '继续：把 NOTES.md 再补一行测试命令', mode: 'default', effort: 'high' });

const session = (id: string, title: string, workspace: string, runnerId: string, status: string, min: number, extra: Record<string, unknown> = {}) => ({
  id, title, workspaceId: W[workspace], workspace: { id: W[workspace], name: workspace }, runnerId, assignedRunnerId: runnerId,
  provider: 'deepseek-harness', model: PRO, effort: 'high', permissionMode: 'default', status, runState: status,
  lifecycleState: 'OPEN', sessionState: 'OPEN', pendingApprovals: 0, createdAt: ago(min), updatedAt: ago(0), lastTurnAt: ago(min > 5 ? min : 0),
  pinnedAt: null, tags: [], ...extra,
});
const S1 = uid(), S3 = uid(), S4 = uid(), S5 = uid(), S6 = uid();
const ev = (seq: number, type: string, turnId: string, payload: unknown, min = 0) => ({ seq, type, turnId, payload, ts: ago(min) });
const s1 = () => session(S1, '列出仓库并写 NOTES.md', 'orbit', R1,
  state.stage === 'approval' || state.stage === 'allowed' ? 'RUNNING' : 'AWAITING_INPUT', 4,
  { pendingApprovals: state.stage === 'approval' ? 1 : 0, permissionMode: state.mode, effort: state.effort, lastAssistantText: '根目录有 AGENTS.md、README.md、docs 和 src。' });
const s1Events = () => {
  if (!state.stage) return [];
  const out = [
    ev(1, 'user', 't1', { text: state.prompt }, 4),
    ev(2, 'thinking', 't1', { text: '先看根目录有什么，再写 NOTES.md。写文件需要征得同意（Default 模式下文件只读）。', messageId: 'm1' }, 4),
    ev(3, 'assistant', 't1', { text: '我先列一下仓库根目录。', messageId: 'm2' }, 4),
    ev(4, 'tool_use', 't1', { id: 'c1', toolCallId: 'c1', name: 'bash', input: { command: 'ls' }, kind: 'execute', status: 'pending' }, 4),
    ev(5, 'tool_result', 't1', { toolUseId: 'c1', toolCallId: 'c1', status: 'completed', content: 'AGENTS.md\nREADME.md\ndocs\nsrc', isError: false }, 4),
    ev(6, 'assistant', 't1', { text: '根目录有 AGENTS.md、README.md、docs 和 src。现在写 NOTES.md。', messageId: 'm3' }, 3),
    ev(7, 'tool_use', 't1', { id: 'c2', toolCallId: 'c2', name: 'write_file', input: { path: 'NOTES.md', content: '# Notes\n\nRoot: AGENTS.md, README.md, docs, src\n' }, kind: 'edit', status: 'pending' }, 3),
  ];
  if (state.stage !== 'approval') out.push(
    ev(8, 'tool_result', 't1', { toolUseId: 'c2', toolCallId: 'c2', status: 'completed', content: 'Wrote NOTES.md (52 bytes)', isError: false }, 2),
    ev(9, 'thinking', 't1', { text: '写好了。顺手跑一下测试确认没有破坏什么。', messageId: 'm4' }, 2),
    ev(10, 'tool_use', 't1', { id: 'c3', toolCallId: 'c3', name: 'bash', input: { command: 'npm test -w @orbit/shared' }, kind: 'execute', status: 'in_progress' }, 2),
  );
  if (state.stage === 'stopped' || state.stage === 'resumed') out.push(
    ev(11, 'tool_result', 't1', { toolUseId: 'c3', toolCallId: 'c3', status: 'failed', content: 'Interrupted', isError: true }, 1),
    ev(12, 'interrupt', 't1', {}, 1),
  );
  if (state.stage === 'resumed') out.push(
    ev(13, 'user', 't2', { text: state.followup }, 0),
    ev(14, 'thinking', 't2', { text: '上一轮在跑测试时被停下；NOTES.md 已写好，只需追加一行。', messageId: 'm5' }, 0),
    ev(15, 'assistant', 't2', { text: '已在 NOTES.md 末尾加上测试命令 `npm test -w @orbit/shared`。上一轮的测试被你停止了，没有重跑。', messageId: 'm6' }, 0),
    ev(16, 'result', 't2', { subtype: 'success', result: 'done' }, 0),
  );
  return out;
};
const OTHERS: Record<string, [Record<string, unknown>, unknown[]]> = {
  [S3]: [session(S3, 'Invalid key', 'orbit', R1, 'FAILED', 30, { permissionMode: 'auto' }), [
    ev(1, 'user', 't1', { text: '总结一下 README' }, 30),
    ev(2, 'error', 't1', { message: 'dsh session/prompt (-32603): Invalid API key (status 401 authentication_error)' }, 30)]],
  [S4]: [session(S4, 'Old runner', 'legacy', R2, 'PENDING', 20, { permissionMode: 'dontAsk', error: 'DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first' }), []],
  [S5]: [session(S5, 'Not installed', 'builds', R3, 'FAILED', 15), [
    ev(1, 'user', 't1', { text: '跑一下构建' }, 15),
    ev(2, 'error', 't1', { message: "DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed in Orbit's version directory; automatic engine installation is not authorized — install it from Orbit or run `orbit doctor` on this runner" }, 15)]],
  [S6]: [session(S6, 'No key', 'orbit', R1, 'FAILED', 10), [
    ev(1, 'user', 't1', { text: '看看 CI 为什么红' }, 10),
    ev(2, 'error', 't1', { message: 'DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key for this session; runner and workspace .env credentials are not used' }, 10)]],
};
const sessions = () => [...(state.stage ? [s1()] : []), ...Object.values(OTHERS).map(([s]) => s)];
const providers = () => (state.keys === 'none' ? [DEEPSEEK] : [HARNESS, DEEPSEEK]);

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname.replace(/^\/api/, '');
  const stream = p.match(/^\/sessions\/([^/]+)\/events$/);
  if (p === '/events' || stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    // A session stream replays what follows `sinceSeq`, then pushes each event the state machine adds.
    let sent = Number(url.searchParams.get('sinceSeq') ?? 0);
    const push = () => {
      if (!stream) return;
      const events = stream[1] === S1 ? s1Events() : (OTHERS[stream[1]]?.[1] ?? []);
      for (const e of events as { seq: number }[]) if (e.seq > sent) { res.write(`data: ${JSON.stringify(e)}\n\n`); sent = e.seq; }
    };
    push();
    const t = setInterval(push, 700);
    const k = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(t); clearInterval(k); });
    return;
  }
  const body = req.method === 'GET' ? {} : await readBody(req);
  if (!p.startsWith('/__')) log(`${req.method} ${url.pathname}${url.search}${req.method === 'GET' ? '' : ` body=${JSON.stringify(body)}`}`);
  if (p === '/__reset') { reset(); return json(res, state); }
  if (p === '/__set') { Object.assign(state, Object.fromEntries(url.searchParams)); return json(res, state); }
  if (p === '/__ids') return json(res, { S1, S3, S4, S5, S6, ...Object.fromEntries(Object.entries(W).map(([k, v]) => [`ws:${k}`, v])), R1, R2, R3, P_DSH });
  if (p === '/auth/setup-status') return json(res, { needsSetup: false });
  if (p === '/users/me') return json(res, { id: USER, email: 'wikova@example.com', name: 'Wikova', createdAt: ago(60 * 24 * 90), preferences: { defaultModels: {} }, isAdmin: true, role: 'ADMIN' });
  if (p === '/runners') return json(res, RUNNERS);
  if (p === '/workspaces') return json(res, WORKSPACES);
  if (p === '/providers' || p === '/providers/mine') return json(res, providers());
  if (p === '/providers/presets') return json(res, {});
  if (p === '/sessions/counts') return json(res, WORKSPACES.map((w) => ({ workspaceId: w.id, active: 0, running: 0, jobs: 0, approvals: 0, open: 1 })));
  const install = p.match(/^\/runners\/([^/]+)\/install$/);
  if (install && req.method === 'POST') return json(res, { status: 'pending', engine: body.engine, command: null, message: null, mode: 'install' }, 201);
  if (p === '/sessions' && req.method === 'POST') {
    state.stage = 'approval';
    if (body.prompt) state.prompt = body.prompt;
    if (body.permissionMode) state.mode = body.permissionMode;
    if (body.effort !== undefined) state.effort = body.effort;
    return json(res, s1(), 201);
  }
  const m = p.match(/^\/sessions\/([^/]+)(\/.*)?$/);
  if (m && m[1] !== 'search' && m[1] !== 'counts') {
    const id = m[1];
    const rest = m[2] ?? '';
    const known = id === S1 && state.stage;
    const [row, events] = known ? [s1(), s1Events()] : (OTHERS[id] ?? [null, []]);
    if (id === S1 && req.method === 'POST') {
      if (rest === '/approvals/ap1/decision') { if (body.behavior !== 'deny') state.stage = 'allowed'; return json(res, { id: 'ap1', status: 'ALLOWED' }); }
      if (rest === '/interrupt') { state.stage = 'stopped'; return json(res, { ok: true }); }
      if (rest.startsWith('/turns') || rest === '/resume') { state.stage = 'resumed'; if (body.content || body.prompt) state.followup = body.content ?? body.prompt; return json(res, { turnId: 't2', seq: 13, kind: 'message', placement: 'accepted' }, 201); }
    }
    if (!row) return json(res, { message: 'not found' }, 404);
    if (rest.includes('/events/page')) return json(res, { events, hasMore: false });
    if (rest.startsWith('/approvals')) {
      return json(res, id === S1 && state.stage === 'approval'
        ? [{ id: 'ap1', sessionId: S1, toolName: 'write_file', toolUseId: 'c2', status: 'PENDING', createdAt: ago(3), input: { path: 'NOTES.md', content: '# Notes\n\nRoot: AGENTS.md, README.md, docs, src\n' } }]
        : []);
    }
    if (rest.includes('/diff')) return json(res, { files: [] });
    if (rest.includes('/created-tasks')) return json(res, { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
    if (rest) return json(res, []);
    return json(res, row);
  }
  if (p === '/sessions') return json(res, (url.searchParams.get('view') ?? 'open') === 'open' ? sessions() : []);
  if (p.startsWith('/tasks/evidence-decisions/pending')) return json(res, { decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
  if (p.startsWith('/tasks/page')) return json(res, { items: [], nextCursor: null });
  if (p.startsWith('/tasks')) return json(res, { items: [], total: 0, counts: {} });
  return json(res, []);
}).listen(PORT, '127.0.0.1', () => console.log('fake api on', PORT));
