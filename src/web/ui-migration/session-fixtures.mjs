import { uuidToBase62 } from '@orbit/shared';

// Synthetic display data, not parser fixtures or copied production run_event records.
// The actual WorkspaceView and Transcript consume these REST/SSE-shaped messages.
export const SESSION_TIME = '2026-09-28T12:00:00.000Z';
export const RUNNER = {
  id: uuidToBase62('0196e000-0000-7000-8000-000000000030'),
  name: 'Baseline runner', online: true, maxConcurrent: 2, activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
  commands: [{ name: 'review', description: 'Review the current changes', provider: 'claude' }],
  skills: [{ name: 'release', description: 'Prepare a release', provider: 'claude' }],
};
export const WORKSPACE = {
  id: uuidToBase62('0196e000-0000-7000-8000-000000000020'),
  name: 'Orbit baseline', runnerId: RUNNER.id, createdAt: SESSION_TIME,
  lastProvider: 'claude', provider: 'claude', model: null, effort: null,
};
export const SESSION = {
  id: uuidToBase62('0196e000-0000-7000-8000-000000000010'),
  workspaceId: WORKSPACE.id, workspace: WORKSPACE,
  runnerId: RUNNER.id, assignedRunnerId: RUNNER.id,
  title: 'Review the component migration', provider: 'claude',
  status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
  createdAt: SESSION_TIME, updatedAt: SESSION_TIME, startedAt: SESSION_TIME,
  engineStartedAt: SESSION_TIME, lastTurnAt: SESSION_TIME,
  shareToken: null,
};
export const SESSION_PATH = `/sessions/${SESSION.id}`;
export const STREAM_TEXT = 'The input, attachment menu, and notification keep their current appearance.';
export const SEND_ERROR = 'Baseline fixture: the runner is temporarily unavailable.';
const TURN_ID = uuidToBase62('0196e000-0000-7000-8000-000000000040');
const STREAM_TURN_ID = uuidToBase62('0196e000-0000-7000-8000-000000000041');
export const SESSION_EVENTS = [
  { seq: 1, type: 'user', payload: { text: 'Keep the current appearance and keyboard behavior.\n请保留现有外观与键盘交互。' }, turnId: TURN_ID, ts: SESSION_TIME },
  { seq: 2, type: 'assistant', payload: { text: 'I will verify the **existing interface** before changing components.\n\n- Light and dark themes\n- Desktop and phone layouts\n- Input focus and attachments\n\n`npm run test:ui-migration -w @orbit/web`' }, turnId: TURN_ID, ts: SESSION_TIME },
  { seq: 3, type: 'turn_end', payload: {}, turnId: TURN_ID, ts: SESSION_TIME },
];

export async function sessionApi(route) {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace(/^\/api/, '');
  const reply = async (body, status = 200) => {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    return true;
  };
  if (path === '/attachments' && request.method() === 'POST') {
    return reply({ id: uuidToBase62('0196e000-0000-7000-8000-000000000050') });
  }
  if (path === `${SESSION_PATH}/turns/current-work-routing` && request.method() === 'POST') {
    return reply({ message: SEND_ERROR }, 503);
  }
  // Any new write must be explicitly modeled, never mistaken for one of the read seeds.
  if (request.method() !== 'GET') return false;
  if (path === '/sessions/counts') {
    return reply([{ workspaceId: WORKSPACE.id, active: 0, running: 0, jobs: 0, needsYou: 0 }]);
  }
  if (path === '/sessions') return reply([SESSION]);
  if (path === '/session-tags' || path === '/session-folders') return reply([]);
  if (path === '/providers/pools' || path === '/providers/shared-pools') return reply([]);
  if (path === '/tasks/evidence-decisions/pending') {
    return reply({ decidingSessionId: SESSION.id, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
  }
  if (!path.startsWith(SESSION_PATH)) return false;
  const suffix = path.slice(SESSION_PATH.length);
  if (!suffix) return reply(SESSION);
  if (suffix === '/events/page') return reply({ events: SESSION_EVENTS, hasMore: false });
  if (['/turns', '/approvals', '/background'].includes(suffix)) return reply([]);
  if (suffix === '/diff') return reply({ files: [], patches: [] });
  if (suffix === '/created-tasks') return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
  return false;
}

// A deliberately idle transport avoids network retries and random reconnection jitter.
// It keeps the application's real SSE handlers, and only the scenario drives the frames.
export async function installSessionStream(page) {
  await page.addInitScript(() => {
    const streams = [];
    class FixtureEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      CONNECTING = 0;
      OPEN = 1;
      CLOSED = 2;
      readyState = 1;
      onopen = null;
      onmessage = null;
      onerror = null;
      constructor(url) {
        super();
        this.url = new URL(url, location.href).href;
        streams.push(this);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() { this.readyState = 2; }
      emit(frame) {
        const event = new MessageEvent('message', { data: JSON.stringify(frame) });
        this.onmessage?.(event);
        this.dispatchEvent(event);
      }
    }
    window.EventSource = FixtureEventSource;
    window.__uiMigrationStreams = streams;
  });
}

export async function sessionStream(page, phase) {
  const common = { turnId: STREAM_TURN_ID, ts: SESSION_TIME };
  const frames = phase === 'start' ? [
    { ...common, seq: 4, type: 'user', payload: { text: 'Check the composer next.' } },
    { ...common, seq: 5, type: 'text_delta', payload: { text: STREAM_TEXT.slice(0, 34) } },
    { ...common, seq: 6, type: 'text_delta', payload: { text: STREAM_TEXT.slice(34) } },
  ] : [
    { ...common, seq: 7, type: 'assistant', payload: { text: STREAM_TEXT } },
    { ...common, seq: 8, type: 'turn_end', payload: {} },
  ];
  await page.waitForFunction((path) => window.__uiMigrationStreams?.some((stream) => stream.readyState === 1 && new URL(stream.url).pathname === `/api${path}/events`), SESSION_PATH);
  await page.evaluate(({ path, frames }) => {
    const stream = window.__uiMigrationStreams.findLast((entry) => entry.readyState === 1 && new URL(entry.url).pathname === `/api${path}/events`);
    for (const frame of frames) stream.emit(frame);
  }, { path: SESSION_PATH, frames });
}
