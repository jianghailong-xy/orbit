import { uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, FIXTURE_IDS } from './fixtures.mjs';
import { RUNNER, SESSION, SESSION_EVENTS, SESSION_TIME, WORKSPACE } from './session-fixtures.mjs';

// P5.3 data, on top of installFixtures (later routes win, so every path not modeled here falls through to the P0
// handler and its unhandled-request check): the P0 conversation with a context reading on its last turn, in a list
// that has a session at work, a pinned one, one that failed, one shared, one with a merge conflict, a folder, a
// completed and a trashed session, two tags, and a second workspace; the runner's models and two providers for the
// composer's model menu; and the writes the composer, the menus and their confirmations make (send, queue, interrupt,
// withdraw, upload, rename, tags, pin, complete, trash, purge, folders, config). `state` is read on every request, so
// a test changes an answer before the step that asks. Every write is recorded with its body. Synthetic data only.
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const now = Date.parse(FIXED_NOW);
const at = (offset) => new Date(now + offset).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const P53_IDS = {
  release: id('5301'), flaky: id('5302'), demo: id('5303'), conflict: id('5304'), tagBuild: id('5305'),
  archived: id('5306'), draft: id('5307'), otherWorkspace: id('5308'), folderRelease: id('5311'), folderMade: id('5312'),
  tagDesign: id('5321'), tagOps: id('5322'), sentTurn: id('5331'), queuedTurn: id('5332'), wakeTurn: id('5333'),
  attachment: id('5341'), missing: id('5351'),
};
export const P53_PATHS = {
  session: `/sessions/${SESSION.id}`, newSession: `/workspaces/${WORKSPACE.id}/new`, missing: `/sessions/${P53_IDS.missing}`,
  workspace: `/workspaces/${WORKSPACE.id}`,
};
export const TAGS = [
  { id: P53_IDS.tagDesign, name: 'Design', color: '#3b82f6' },
  { id: P53_IDS.tagOps, name: 'Ops', color: '#f59e0b' },
];
const OTHER_WORKSPACE = { ...WORKSPACE, id: P53_IDS.otherWorkspace, name: 'wikova-develop', createdAt: at(-3 * DAY) };
export const MODELS = [
  { label: 'Opus 5.5', value: 'claude-opus-5-5', contextWindow: 1_000_000 },
  { label: 'Sonnet 5.5', value: 'claude-sonnet-5-5', contextWindow: 1_000_000 },
  { label: 'Fable 5.1', value: 'claude-fable-5-1', contextWindow: 1_000_000 },
];
const runner = () => ({ ...RUNNER, modelCatalog: { claude: MODELS } });
const PROVIDERS = [
  { slug: 'anthropic-2', label: 'orbitd@Claude', runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true },
  { slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', presetSlug: 'deepseek', models: [{ label: 'DeepSeek V4 Flash', value: 'deepseek-flash' }] },
];

// ── the list ─────────────────────────────────────────────────────────────────────────────────────
const row = (suffix, title, extra = {}) => ({
  ...SESSION, id: suffix, title, workspace: WORKSPACE, workspaceId: WORKSPACE.id, folderId: null, tags: [], pinnedAt: null,
  shared: false, mergeStatus: null, status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
  ...extra,
});
function rows(state) {
  const open = [
    row(SESSION.id, SESSION.title, { tags: state.tags.map((tag) => TAGS.find((t) => t.id === tag)), lastTurnAt: at(-2 * MIN), updatedAt: at(-2 * MIN),
      lastAssistantText: 'I will verify the existing interface before changing components.', model: state.model, effort: state.effort,
      provider: state.provider, permissionMode: state.permissionMode,
      status: state.running ? 'RUNNING' : 'AWAITING_INPUT', runState: state.running ? 'RUNNING' : 'AWAITING_INPUT' }),
    row(P53_IDS.release, 'Ship the release notes', { pinnedAt: at(-DAY), status: 'RUNNING', runState: 'RUNNING', lastTurnAt: at(-5 * MIN),
      lastUserText: 'Draft the notes for 0.9', tags: [TAGS[1]] }),
    row(P53_IDS.flaky, 'Fix the flaky upload test', { status: 'FAILED', runState: 'FAILED', error: 'Import failed: exit status 1',
      lastTurnAt: at(-40 * MIN), lastUserText: 'Run the upload suite again' }),
    row(P53_IDS.demo, 'Demo for the design review', { shared: true, lastTurnAt: at(-HOUR), tags: [TAGS[0], TAGS[1]],
      lastAssistantText: 'The demo session is ready to share.' }),
    row(P53_IDS.conflict, 'Merge the docs branch', { mergeStatus: 'conflict', lastTurnAt: at(-3 * HOUR),
      lastAssistantText: 'The merge stopped on a conflict in docs/index.md.' }),
    row(P53_IDS.tagBuild, 'Tag the build', { folderId: P53_IDS.folderRelease, lastTurnAt: at(-5 * HOUR) }),
  ].filter((s) => !state.trashed.includes(s.id) && !state.completed.includes(s.id));
  const completed = [
    row(P53_IDS.archived, 'Archive the old tokens', { lifecycleState: 'COMPLETED', status: 'COMPLETED', runState: 'COMPLETED', lastTurnAt: at(-2 * DAY) }),
    ...open.filter(() => false),
  ];
  const trash = [row(P53_IDS.draft, 'Draft notes for the pilot', { lifecycleState: 'TRASH', lastTurnAt: at(-4 * DAY) })]
    .filter((s) => !state.purged.includes(s.id));
  return { open, completed, trash };
}
const FOLDER = { id: P53_IDS.folderRelease, workspaceId: WORKSPACE.id, name: 'Release', position: 0, createdAt: at(-5 * DAY) };

// ── the conversation ─────────────────────────────────────────────────────────────────────────────────
// The P0 turn, its end carrying a context reading (18% of a 1M window), so the composer's ring has a number.
const EVENTS = SESSION_EVENTS.map((event) => event.type === 'turn_end'
  ? { ...event, payload: { ...event.payload, contextTokens: 182_000, contextWindow: 1_000_000 } } : event);
export const STREAM_TURN = id('5361');
/** The frames of the turn the test's message starts, as the runner streams them. */
export const streamFrames = (phase) => {
  const common = { turnId: STREAM_TURN, ts: SESSION_TIME };
  return phase === 'start' ? [
    { ...common, seq: 4, type: 'user', payload: { text: 'Check the composer next.' } },
    { ...common, seq: 5, type: 'text_delta', payload: { text: 'The composer keeps its menus, ' } },
    { ...common, seq: 6, type: 'text_delta', payload: { text: 'its attachments and its height.' } },
  ] : [
    { ...common, seq: 7, type: 'assistant', payload: { text: 'The composer keeps its menus, its attachments and its height.' } },
    { ...common, seq: 8, type: 'turn_end', payload: { contextTokens: 240_000, contextWindow: 1_000_000 } },
  ];
};

/** A one-pixel-per-quadrant PNG the composer can draw as a picked image: four colours, so a crop shows its corners. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4nGP8z8Dwn4EIwESMolGFowpHFY4qHFU4qnBU4ajCUYWjCkcVjiocVTiqcFThoMJBhQMAAPkpBR3H4gOVAAAAAElFTkSuQmCC',
  'base64');

export async function installP53Fixtures(page, initial = {}) {
  const state = {
    running: false, queued: [], tags: [P53_IDS.tagDesign], trashed: [], purged: [], completed: [], pinned: [],
    model: 'claude-opus-5-5', effort: 'max', provider: 'anthropic-2', permissionMode: 'default', folders: [FOLDER], titles: {},
    turnHold: null, uploadHold: null, missingHold: null, ...initial,
  };
  const requests = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    const body = () => { try { return request.postDataJSON(); } catch { return request.postData(); } };
    const note = () => requests.push({ method, path, query: searchParams.toString() || undefined,
      body: method === 'GET' || method === 'DELETE' ? undefined : (request.headers()['content-type'] ?? '').startsWith('multipart/') ? 'multipart' : body() });
    const S = `/api/sessions/${SESSION.id}`;

    if (method === 'GET' && path === '/api/runners') return json([runner()]);
    if (method === 'GET' && path === `/api/runners/${RUNNER.id}`) return json(runner());
    if (method === 'GET' && path === '/api/workspaces') return json([WORKSPACE, OTHER_WORKSPACE]);
    if (method === 'GET' && path === '/api/providers') return json(PROVIDERS);
    if (method === 'GET' && path === '/api/session-tags') return json(TAGS);
    if (method === 'GET' && path === '/api/session-folders') return json(state.folders);
    if (method === 'GET' && path === '/api/sessions/counts') {
      return json([{ workspaceId: WORKSPACE.id, active: 2, running: 1, jobs: 0, needsYou: 0 },
        { workspaceId: OTHER_WORKSPACE.id, active: 0, running: 0, jobs: 0, needsYou: 0 }]);
    }
    if (method === 'GET' && path === '/api/sessions') {
      if (searchParams.get('projectId')) return json([]);
      const list = rows(state);
      const view = searchParams.get('view') ?? 'open';
      const tag = searchParams.get('tagId');
      const shown = (view === 'trash' ? list.trash : view === 'completed' ? list.completed : list.open)
        .filter((s) => !tag || s.tags?.some((t) => t?.id === tag))
        .map((s) => ({ ...s, title: state.titles[s.id] ?? s.title, pinnedAt: state.pinned.includes(s.id) ? at(-HOUR) : s.pinnedAt }));
      return json(shown);
    }
    // A session link that leads nowhere: the console's not-found state (held, to show its spinner first).
    if (method === 'GET' && path === `/api/sessions/${P53_IDS.missing}`) {
      if (state.missingHold) await state.missingHold.promise;
      return json({ message: 'Session not found' }, 404);
    }
    if (method === 'GET' && path === S) {
      const open = rows(state).open.find((s) => s.id === SESSION.id) ?? rows(state).open[0];
      return json({ ...SESSION, ...open, title: state.titles[SESSION.id] ?? SESSION.title, capabilities: { canSend: true, canResume: true, canComplete: true, canRestore: true } });
    }
    if (method === 'GET' && path === `${S}/events/page`) return json({ events: EVENTS, hasMore: false });
    if (method === 'GET' && path === `${S}/turns`) return json(state.queued);
    for (const other of [P53_IDS.release, P53_IDS.flaky, P53_IDS.demo, P53_IDS.conflict, P53_IDS.tagBuild, P53_IDS.archived, P53_IDS.draft]) {
      const base = `/api/sessions/${other}`;
      if (method === 'GET' && path === base) {
        const all = rows(state);
        return json({ ...[...all.open, ...all.completed, ...all.trash].find((s) => s.id === other) });
      }
      if (method === 'GET' && path === `${base}/events/page`) return json({ events: [], hasMore: false });
      if (method === 'GET' && ['/turns', '/approvals', '/background'].some((suffix) => path === `${base}${suffix}`)) return json([]);
      if (method === 'GET' && path === `${base}/diff`) return json({ files: [], patches: [] });
      if (method === 'GET' && path === `${base}/created-tasks`) return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (method === 'GET' && path === `${base}/share`) return json({ link: null, counts: { messages: 0, toolCalls: 0 } });
    }
    if (method === 'GET' && path === `${S}/share`) return json({ link: null, counts: { messages: 2, toolCalls: 0 } });
    // Find in session: the reply's one match.
    if (method === 'GET' && path === `${S}/events/search`) {
      const q = searchParams.get('q') ?? '';
      const hits = /interface/i.test(q) ? [{ seq: 2, type: 'assistant', toolName: null, ts: SESSION_TIME,
        snippet: 'I will verify the existing interface before changing components.' }] : [];
      return json({ q, total: hits.length, hits });
    }
    if (method === 'GET' && path.endsWith('/move-targets')) {
      return json({ workspaceId: WORKSPACE.id, folderId: null, folders: state.folders.map((f) => ({ id: f.id, name: f.name, sessionCount: 1 })),
        reason: null, needsEnd: false, branch: null, changedFiles: 0, unmergedFiles: 0, mergeTarget: null, targets: [] });
    }

    // ── the composer's writes
    if (method === 'POST' && path === `${S}/turns/current-work-routing`) {
      note();
      if (state.turnHold) await state.turnHold.promise;
      const sent = body();
      if (state.running) {
        const turn = { turnId: P53_IDS.queuedTurn, kind: 'message', placement: 'queued', content: sent.content, createdAt: FIXED_NOW };
        state.queued = [turn];
        return json({ turnId: turn.turnId, seq: 0, kind: 'message', placement: 'queued' });
      }
      return json({ turnId: P53_IDS.sentTurn, seq: 4, kind: 'message', placement: 'accepted' });
    }
    if (method === 'DELETE' && path.startsWith(`${S}/turns/`)) {
      note();
      state.queued = state.queued.filter((turn) => !path.endsWith(turn.turnId));
      return json({ ok: true });
    }
    if (method === 'POST' && path === `${S}/interrupt`) { note(); state.running = false; return json({ ok: true }); }
    if (method === 'POST' && path === '/api/attachments') {
      note();
      if (state.uploadHold) await state.uploadHold.promise;
      return json({ id: P53_IDS.attachment });
    }
    if (method === 'GET' && path === `/api/attachments/${P53_IDS.attachment}`) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (method === 'PATCH' && path === `${S}/config`) {
      note();
      Object.assign(state, Object.fromEntries(Object.entries(body()).filter(([key]) => ['model', 'effort', 'provider', 'permissionMode'].includes(key))));
      return json({ ok: true });
    }
    if (method === 'PATCH' && path === '/api/users/me/preferences') { note(); return route.fallback(); }

    // ── the menus' writes
    const session = path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (session && method !== 'GET') {
      note();
      const [, target, suffix = ''] = session;
      if (method === 'PATCH' && !suffix) { state.titles[target] = body().title; return json({ ok: true }); }
      if (method === 'PUT' && suffix === '/tags') {
        if (target === SESSION.id) state.tags = body().tagIds;
        return json(TAGS.filter((tag) => body().tagIds.includes(tag.id)));
      }
      if (suffix === '/pin') {
        state.pinned = method === 'POST' ? [...state.pinned, target] : state.pinned.filter((s) => s !== target);
        return json({ ok: true });
      }
      if (method === 'POST' && suffix === '/complete') { state.completed.push(target); return json({ ok: true }); }
      if (method === 'DELETE' && !suffix) { state.trashed.push(target); return json({ ok: true }); }
      if (method === 'DELETE' && suffix === '/purge') { state.purged.push(target); return json({ ok: true }); }
      if (method === 'POST' && suffix === '/restore') return json({ ok: true });
      return json({ ok: true });
    }
    if (method === 'POST' && path === '/api/session-folders') {
      note();
      const folder = { id: P53_IDS.folderMade, workspaceId: body().workspaceId, name: body().name, position: 1, createdAt: SESSION_TIME };
      state.folders = [...state.folders, folder];
      return json(folder);
    }
    if (path.startsWith('/api/session-folders/') && method !== 'GET') {
      note();
      const folderId = path.split('/').pop();
      if (method === 'DELETE') { state.folders = state.folders.filter((f) => f.id !== folderId); return json({ ok: true }); }
      const renamed = { ...state.folders.find((f) => f.id === folderId), name: body().name };
      state.folders = state.folders.map((f) => (f.id === folderId ? renamed : f));
      return json(renamed);
    }
    return route.fallback();
  });
  return { state, requests };
}

/** Hold a response until `release()`, so a loading state can be captured without a race. */
export function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/** Emit SSE frames on the open conversation's stream (the P0 fixture's EventSource stands in for the network). */
export async function emit(page, frames) {
  const path = `/sessions/${SESSION.id}`;
  await page.waitForFunction((path) => window.__uiMigrationStreams?.some((stream) => stream.readyState === 1 && new URL(stream.url).pathname === `/api${path}/events`), path);
  await page.evaluate(({ path, frames }) => {
    const stream = window.__uiMigrationStreams.findLast((entry) => entry.readyState === 1 && new URL(entry.url).pathname === `/api${path}/events`);
    for (const frame of frames) stream.emit(frame);
  }, { path, frames });
}

export { FIXTURE_IDS, SESSION, WORKSPACE, RUNNER };
